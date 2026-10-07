# 客户端与 Remote 接口

本文说明客户端交互、严格 Remote 合约和插件生命周期。实际验证结果见[客户端验证](verification/client-interface.md)，实现状态见 [README](../README.md)。

## 交互与所有权

会话行的原生菜单加入“移入回收站”，已属于本插件目录的会话显示“恢复”。菜单先通过原生 `useMenuOpenState` 关闭，再请求 Host。只有 Host 确认的成功结果才显示成功通知；移入提供撤销，撤销绑定当次 `entryId`，不会恢复同名会话后来创建的新条目。

侧栏入口与根 `main` 槽位共用 `dsh-session-bin.panel` 身份。面板显示本插件目录，原生归档不会被当作回收站条目。名称来自原生 Session 摘要，工作区按当前 `WorkspaceView.sessionIds` 匹配；不为列表激活或 retain 冷会话，也不读取日志内容。支持名称及工作区元数据搜索、当前工作区筛选、单项恢复和固定选择的批量恢复。移入时间来自持久化 `binnedAt`。

选中对象使用 `entryId`，每个恢复请求再次核对 Host 准备结果中的条目身份。批量开始时固定对象集合，后来移入的会话不加入批次。成功项取消选择，失败项仍可检查原因；目录中已经失效的对象退出选择。移入前已经归档的条目显示原归档提示，恢复后仍保持原生归档。

界面使用宿主 Button、Checkbox、Input、MenuItemButton、Toast 和图标；特有布局使用 CSS Modules 与宿主语义 token。字典在独立 `dshSessionBin` namespace 注册完整中英文，单项数量使用专用模板；空名已分组工作区与未分组分别显示，不改变用户提供的名称。原生插件管理名称和描述由公开的 [English metadata](../locale/en.json) 与[中文 metadata](../locale/zh.json)提供。原生 Settings 切换语言时面板、菜单、侧栏、辅助标签与日期更新，选择和搜索草稿保留；具体证明见[双语验证矩阵](verification/client-interface.md)。搜索在 composition 期间保留草稿，结束后应用筛选；Escape 不截断组合输入。浅深色由宿主主题解析，窄屏保持控件与列表可访问。

## 严格 Remote 边界

[Remote 合约](../src/remote/contracts.ts)使用公开手工 `TypertContribution` 和 `InvocationDescriptor`，与 Host DTO schema 共用声明。Host 注册的 Service 是 `sessionBinRemote`，wire namespace 是 `sessionBin`；[适配器](../src/host/remote.ts)通过公开 `TypertRemoteService` 绑定已有 Host Interface，不增加自定义 HTTP 路由。

| 客户端调用 | 结果 |
| --- | --- |
| `prepare(request, signal?)` | `RemoteResult<BinPlan>`，只准备并复核状态。 |
| `execute(plan, signal?)` | `RemoteResult<BinResult>`，Host 重新检查并记录可查询回执。 |
| `list(signal?)` | `RemoteResult<BinEntry[]>`，完整目录。 |
| `getOperation(operationId, signal?)` | `RemoteResult<BinOperation \| null>`，不存在时用 JSON-safe 的 null。 |
| `follow(signal?)` | `RemoteStreamHandle<BinSnapshot, never>`，每代先发送完整 `{schemaVersion:1, entries}`，后续合并并替换。 |

输入由 Gateway 检查 exact args 和严格 schema。当前 SDK 默认不校验 JSON 输出，本插件提供显式 encode/decode 校验，流端由 Host 和 Client 各校验完整快照。业务 `rejected`、`conflict` 是成功传输中的逐项状态；Transport/Host 错误为 `RemoteResult.ok:false`，不能混为操作成功。已经进入 Host 队列的变更会完成持久化，客户端取消回复不自动撤销它。

浏览器先在外层调用 `ctx.remote.$mount`，再建立声明 `remote.sessionBin` 及所需原生服务的动态消费 fiber。Cordis 对 dotted namespace 的依赖有独立检查，仅声明 `remote` 不够；直接根 Context 的测试不能证明实际插件可以读取该服务。提前把本插件自己提供的 namespace 放入外层静态依赖又会造成启动等待，所以按“挂载 → 动态依赖 → UI”的顺序执行。

## 连接恢复与卸载

[客户端模型](../src/client/model.ts)消费 Gateway 的重连 stream。每个新代校验完整目录后接受 baseline；旧代取消后不再发布状态。刷新重建订阅，保留已有目录至新基线；连接失败时显示重试入口并限制新变更。

执行前保存完整计划及操作身份，浏览器 sessionStorage 可用时在同一页面会话中保留，重载后先查询回执。连接基线只查询未知结果，不自动再提交变更。用户显式“检查并重试”时，若 Host 没有该回执，重发同一计划和身份；Host 仍复核状态并保证幂等。已确认的中断冲突需要新的明确操作，不能换身份盲目重试。浏览器禁止 sessionStorage 时，本页面仍保留内存记录，跨页面重载的保留能力受限。

Host follow 使用插件 domain 的变化订阅，先订阅后取基线，合并重复通知。流不是持久化 journal。取消、return、卸载均唤醒等待并移除监听。Client 所有槽位、locale、样式和模型订阅绑定动态消费者；父插件卸载撤销 Remote namespace 并释放子插件。样式具有 Module Loader 的 `data-plugin` 所有权标记。

鉴权沿用宿主 Connection 的浏览器 session、Host/Origin 检查与 operator scope。测试用逻辑 carrier 时处于已准入边界，不能据此宣称验证了 cookie 或 WebSocket；真实 CLI/profile 浏览器检查另行记录。

## 构建和检查

`./client` 导出预编译 DSH lazy CommonJS factory，React、React JSX runtime 和原生 primitives 从平台基线解析，保留共享身份。特有 CSS Modules 样式嵌入工厂并由 fiber 管理；`./remote` 导出浏览器安全的严格贡献，Host 入口不进入客户端依赖图。两个 TypeScript face 分开检查，避免同名 Context 服务冲突。配置与命令分别在 [mise.toml](../mise.toml) 和 [package.json](../package.json)。

- `mise run verify`：两端类型检查、构建、Host/Remote/客户端模型测试和 tarball 检查。
- `mise run verify:gui`：按顺序验收中文与 English，每轮在独立临时 DSH_HOME 中通过公开 CLI 安装 tarball，启动真正 `dsh web`，用隔离 Chrome profile 检查精确语言文案、切换和交互并截图，最后卸载并验证新启动的页面。它只连接脚本启动的独立测试宿主，不使用开发者的运行中 profile。
- `DSH_GUI_LOCALE=zh-CN` 或 `en-US` 与 `mise run verify:gui:locale`：仅用于单语诊断。

GUI 检查先用 `mise run install` 将锁定依赖安装到项目并填充 `.local/` 下的离线 store/cache，再运行 `mise run verify:gui`。需要本机可用的 Chrome；可通过 `DSH_GUI_BROWSER_EXECUTABLE` 指定其他 Chromium 可执行文件。脚本为自己的 CLI 进程设置非交互 CI 环境，`--port 0` 使用系统空闲端口，私下消费认证 URL，日志与报告去除 token。数据、截图和报告保留在忽略的 `.local/gui/` 随机目录，不加入发布产物。

## 当前边界

仍沿用[Host 生命周期](host-lifecycle.md)的单 Host 部署、精确 SDK 版本、POSIX lease 与未观察归档变化限制。此切片没有日志预览、自动清空、永久删除、跨设备同步或多 Host 原生存储协调。通过验证后扩大能力或平台范围，不从源码存在推断已经支持。
