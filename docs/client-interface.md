# 客户端与 Remote 接口

本文说明客户端交互、严格 Remote 合约和插件生命周期。实际验证结果见[客户端验证](verification/client-interface.md)，实现状态见 [README](../README.md)。

## 原生归档管理

Harness 原生 Archive 是唯一归档入口。插件不注册会话菜单中的“移入回收站”，也不提供第二个归档 Undo；归档活动保护、停止确认及撤销由宿主原生交互负责。

侧栏入口与根 `main` 槽位共用 `dsh-session-bin.panel` 身份。面板直接展示原生已归档集合，包括插件安装前或由其他原生界面归档的会话。名称来自原生 Session 摘要，工作区按当前 `WorkspaceView.sessionIds` 匹配；不为列表激活或 retain 冷会话，也不读取日志。支持名称及工作区元数据搜索、工作区筛选、单项取消归档和固定选择的批量取消归档。

选中对象使用 Host 的观察 `entryId`。请求再次核对准备结果中的身份，批量在开始时固定对象集合；后来归档的会话不加入。成功项取消选择，失败项保留并显示逐项原因，已经退出集合的对象退出选择。取消归档始终移除原生归档标记，不沿用旧 Bin 的 `wasArchived`。原生集合没有归档时间；列表不显示旧移入时间、首次观察时间或“原先已归档”标签。观察身份也不是宿主生命周期或原生归档代际，不能保证识别未观察的取消归档再归档。

界面使用宿主 Button、Checkbox、Input、Toast 和图标；布局使用 CSS Modules 与宿主语义 token。字典在独立 `dshSessionBin` namespace 注册完整中英文。原生插件管理元数据由 [English metadata](../locale/en.json) 与[中文 metadata](../locale/zh.json)提供。语言切换更新面板、侧栏及辅助标签，保留选择和搜索草稿；用户会话及工作区名称保持原值。搜索在 composition 期间保留草稿，结束后应用筛选；Escape 不截断组合输入。浅深色由宿主主题解析。

## 严格 Remote 边界

[Remote 合约](../src/remote/contracts.ts)使用公开手工 `TypertContribution` 和 `InvocationDescriptor`，与 Host DTO schema 共用声明。Host Service 是 `sessionBinRemote`，wire namespace 是 `sessionBin`；[适配器](../src/host/remote.ts)通过公开 `TypertRemoteService` 绑定 Host Interface，不增加自定义 HTTP 路由。

| 客户端调用 | 结果 |
| --- | --- |
| `prepare({ action: 'unarchive', sessionId, operationId? }, signal?)` | `RemoteResult<ArchivePlan>`，只准备并复核状态。 |
| `execute(plan, signal?)` | `RemoteResult<ArchiveResult>`，复核固定观察对象与当前原生归档状态，保存回执。 |
| `list(signal?)` | `RemoteResult<ArchiveEntry[]>`，完整原生归档管理集合。 |
| `getOperation(operationId, signal?)` | `RemoteResult<ArchiveOperation \| BinOperation \| null>`，保留旧 v1 回执查询。 |
| `follow(signal?)` | 每代完整 `{schemaVersion:2, entries}`，后续合并通知并替换快照。 |

新条目和计划使用 v2 合约；旧 Bin domain 的 v1 合约留作兼容，不作为成员来源。新 Remote 不接受旧 `bin/restore` 变更。输入由 Gateway 检查 exact args 和严格 schema；输出提供显式 encode/decode 校验，流端由 Host 和 Client 各校验完整快照。业务 `rejected/conflict` 与 Transport/Host 的 `RemoteResult.ok:false` 分开处理。已经进入 Host 队列的请求完成持久化，客户端取消回复不会撤销已开始的操作。

浏览器先调用 `ctx.remote.$mount`，再建立声明 `remote.sessionBin` 的动态消费 fiber，按“挂载 → 动态依赖 → UI”的顺序执行。React、React JSX runtime、Cordis 和原生 primitives 复用平台身份。

## 连接恢复与卸载

[客户端模型](../src/client/model.ts)消费 Gateway 重连 stream。新代校验完整集合后接受 baseline，取消旧代不发布状态。连接失败显示重试入口并限制新变更。

执行前保存完整计划及操作身份。浏览器 sessionStorage 可用时在同一页面会话中保留，重载先查询回执。连接基线只查询未知结果，不自动重发变更。显式“检查并重试”仅能在缺少回执时重新提交同一个新版计划；Host 仍复核状态并保证幂等。旧 v1 缓存迁移为只查询回执的记录，缺少旧回执也不能重放 `bin/restore`。旧成功结果不能被误报成新版取消归档成功。浏览器禁止存储时保留内存记录，跨页面能力受限。

Host follow 订阅原生 Workspace 与插件元数据变化，先订阅后取 baseline，合并重复通知；流不是持久化 journal。取消、return、卸载唤醒等待并移除监听。所有槽位、locale、样式和模型订阅绑定动态消费者；父插件卸载撤销 Remote namespace 并释放子插件。样式具有 Module Loader 的 `data-plugin` 所有权标记。

鉴权沿用宿主 Connection 的浏览器 session、Host/Origin 检查与 operator scope。逻辑 carrier 测试处于已准入边界；真实 CLI/profile 浏览器检查单独记录。

## 构建和检查

`./client` 导出预编译 DSH lazy CommonJS factory。特有 CSS Modules 嵌入工厂并由 fiber 管理；`./remote` 是浏览器安全合约，Host 入口不进入客户端依赖图。两个 TypeScript face 分开检查，配置与命令分别在 [mise.toml](../mise.toml) 和 [package.json](../package.json)。

- `mise run verify`：两端类型检查、构建、Host/Remote/模型及文案测试、tarball 检查。
- `mise run verify:gui`：顺序验收中文与 English，独立临时 DSH_HOME 中用公开 CLI 安装 tarball、启动真正 `dsh web`，检查原生 Archive/Undo、已有归档、取消归档、固定选择批量操作、语言切换、浅深色、窄屏和卸载。
- `DSH_GUI_LOCALE=zh-CN` 或 `en-US` 与 `mise run verify:gui:locale`：单语诊断。

GUI 检查先运行 `mise run install` 填充离线缓存，需要可用 Chrome，可由 `DSH_GUI_BROWSER_EXECUTABLE` 指定 Chromium。脚本的 Host 使用系统空闲端口；只连接自己的独立测试宿主，不使用当前 GUI/profile。日志与报告移除认证 token，数据与截图保留在忽略的 `.local/gui/`。

## 当前边界

单 Host 部署、精确 SDK 版本、POSIX lease 及原生归档观察限制见[Host 生命周期](host-lifecycle.md)。本切片没有日志预览、自动清空、永久删除、跨设备同步或多 Host 原生存储协调。永久删除的准入与原生归档集合管理分别验证。
