# 客户端切片验证

状态：本地两端验证及中文、English 真实 GUI 验证通过。目标为 DSH 0.2.0-rc.2、Node 24.18.1、pnpm 11.7.0、macOS ARM64，私有开发包 0.1.0-dev.0。真实浏览器为系统 Chrome 154.0.8037.98。

## 本地集成基线

Host 切片提交为 `a151d56c494d4ac63464a8abaf48e9ad2ee38524`，包含完整 Conventional Commit 正文、17 项 Host 测试和打包证据。已 fast-forward 合并本地 `main`，客户端从该提交新建的 `feat/bin-client` 分支继续。没有远程推送或公开发布。

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

## 客户端初始 GUI 验收

此前客户端切片的[中文完整报告](../../.local/gui/client-K7Nop4/verification.json)记录了以下实际通过项；本轮中英补充验收见下一节。

- 公开 CLI 真实安装并注册 bundle，客户端出现在原生 boot graph；独立新 profile 的预览说明及模型设置向导通过原生“继续 / 稍后配置”关闭，不填密钥、不创建 Agent 或发模型请求。
- 空回收站排除普通原生归档；原生会话菜单的键盘导航、Escape 和焦点返回正常。
- 移入、Toast Undo、面板单项恢复、批量恢复均经过实际传输；原先已归档的对象恢复后仍保持原生归档。
- 真实标题来自持久化 projection，搜索与当前工作区筛选正确；composition 完成、Escape、键盘中文文字与 Tab 均执行检查。
- 浅深色均由宿主主题呈现；390×844 视口中面板位于 x=56、宽 334、高 844，所有输入/选择/按钮横向边界在视口内，批量恢复按钮底部 y=815 可见。
- 页面完整重载重建客户端与空目录；停止真正 Host 后通过 SDK 重开检查，四个测试日志内容完全相同，普通原生归档与原先已归档对象保持归档，两个恢复对象已取消归档。
- 公开 CLI 卸载真实返回退出码 0，profile dependency 和 bundle 选择移除；第二次真正 Web 启动不再有本插件 boot entry 或入口，原生页面正常可用。

实际截图：[浅色](../../.local/gui/client-K7Nop4/artifacts/session-bin-light.png)、[深色](../../.local/gui/client-K7Nop4/artifacts/session-bin-dark.png)、[窄屏](../../.local/gui/client-K7Nop4/artifacts/session-bin-narrow.png)。这些是独立测试 profile 的真实渲染，不是概念图。

该轮[GUI tarball](../../.local/gui/client-K7Nop4/dsh-session-bin-0.1.0-dev.0.tgz) SHA-256：`60a8c46c63c838d7e289bec80d0b43a61a845314f6883d376658cde75508b0ff`。报告保存去除认证参数的 loopback URL；测试 Host 和 Chrome 均在验证结束时关闭。后续只改文档也会改变 tarball 摘要，其他运行的摘要以各自报告为准。

## 中文与 English 完整适配验证

本轮补齐了原报告只有中文实跑、English 仅类型完整性的缺口，并修复英文单项语法、空名已分组工作区的语义，以及插件管理页的中文 metadata。`mise run verify:gui` 现在顺序运行两个独立 profile，不再用“中英任一匹配”的断言代替语言验证。

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
6. pnpm 11 的 `remove` 不接受 `--ignore-scripts`，脚本使用实际识别的 `PNPM_CONFIG_IGNORE_SCRIPTS=true`。自动化进程设置非交互 CI 环境；此前继承环境下 CLI 卸载完成依赖移除却未退出的失败记录保留在独立旧目录，未伪装为成功。非交互探针与两轮完整新运行真正返回 0 并清理 bundle；不把具体等待机制归因于未证明的更新检查。

## 复现与边界

`mise run install` 准备锁定依赖及项目离线缓存；`mise run verify` 执行两端静态/构建/38 项行为与文案回归及 tarball 检查；`mise run verify:gui` 顺序执行中文和 English 的真实 CLI/Chromium 验收。单语诊断用 `DSH_GUI_LOCALE=zh-CN` 或 `en-US` 与 `mise run verify:gui:locale`。工具、依赖和命令的来源分别为 [mise.toml](../../mise.toml)、[pnpm-lock.yaml](../../pnpm-lock.yaml)及 [package.json](../../package.json)。

脚本仅在忽略的 `.local/gui/` 随机目录建立 DSH_HOME、Workspace、profile、缓存、浏览器数据、测试日志、projection、截图和报告。每次真实 Host 退出后才重开 SDK 检查；停止的进程组全部属于脚本。认证 token、cookie 和凭据不进入公开报告，未连接当前 19387 GUI。

验证只证明上述精确平台和版本。单 Host、POSIX lease 与未观察归档变化的归属限制继续遵循[Host 契约](../host-lifecycle.md)；Windows、Linux 和多 Host 原生存储协调未扩大支持。浏览器文本输入和合成 composition 事件不等于真实操作系统中文输入法会话；中文和 English 已按上述分层矩阵实际验证。尚无公开发布、市场提交或 GitHub CI 远程运行记录，也不提供永久删除、日志预览或自动清空。
