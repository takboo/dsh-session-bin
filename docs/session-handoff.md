# 下一 session 工作入口

下一 session 从本地 `main` 开始；先确认 `git status --short --branch` 干净，再按 [AGENTS](../AGENTS.md) 加载本轮任务相关文档。当前实现与支持范围以 [README](../README.md)、[客户端接口](client-interface.md)和[验证报告](verification/client-interface.md)为准。

## 已完成的基线

- 可恢复的 Host 归档回收站：插件自有条目、schema 校验、操作日志、幂等回执、中断后保守对账与 POSIX lifetime lease。
- 严格 Typert Remote、原生会话菜单、Undo、元数据搜索、当前工作区筛选、固定选择的批量恢复。
- Client lazy factory、平台共享 React/native primitives、动态 namespace 消费者，以及槽位/locale/样式/流的卸载清理。
- 中文与 English 的字典、单复数、fallback、错误/通知文案、原生插件元数据，以及 38 项回归和两个独立浏览器 profile 的实际验收。真实 Settings 切换语言、Host 偏好刷新和两语 390px 布局均通过；实际证据见[验证报告](verification/client-interface.md)。

Host 基线提交 `a151d56`、客户端基线提交 `667ff68`；本轮双语修复及验证提交位于其后。当前仍是 `private: true` 的开发包，没有远程仓库、npm 发布或市场提交。

## 复现检查

工具版本在 [mise.toml](../mise.toml)，实际脚本定义在 [package.json](../package.json)：

1. `mise run install`：固定 pnpm、frozen lockfile、禁用安装脚本，准备项目离线 store/cache。
2. `mise run verify`：Host/Client 类型检查、预编译、全部行为与文案回归、tarball 白名单及公开资源解析。
3. `mise run verify:gui`：顺序检验中文和 English；公开 CLI 安装独立 Web profile、真实 Chrome、语言切换、实际交互/布局、日志重开及卸载后新启动。
4. 单语诊断使用 `DSH_GUI_LOCALE=zh-CN` 或 `en-US` 与 `mise run verify:gui:locale`。Chromium 路径可由 `DSH_GUI_BROWSER_EXECUTABLE` 指定。

测试数据与截图在忽略的 `.local/` 随机目录中。源码快照只供研究；正式构建和运行均使用公开 npm SDK。测试不要连接当前 19387 GUI，不对真实用户会话做破坏性操作。

## 下一步候选

建议下一 session 先明确发布准备范围：核对名称占用、建立远程仓库与真实 CI 记录、完善用户安装/卸载说明和兼容性表，再依[分发与发布](release.md)准备可审阅的分发产物。当前市场规则、仓库年龄和重复功能条件需要重新核对，不能把已有研究当成最新外部规则。

如果选择扩大能力或平台，先做对应版本/提供方的隔离验证。日志预览、Windows/Linux、更多平台和公开发布均未自动承诺。

## 必须保留的边界

- 回收站只包含本插件持久化条目，普通原生归档不属于回收站。
- 移入保留原生活动拒绝；恢复保持移入前归档状态，置顶不自动恢复。
- 支持一个 Host 管理原生 Workspace 存储。共享 backend 需同一协调目录；多 Host 原生存储并发不受插件 lease 保证。
- 原生归档缺 actor/operationId/revision；停用或崩溃期间未观察到的取消归档再归档不能恢复精确归属。
- SDK 尚无完整永久删除接口。不要直接删会话目录、锁文件、共享附件或私有索引来凑功能；永久删除需要独立已验证的资源生命周期协议。
- 浏览器中文文本与合成 composition 检查不等于实际操作系统输入法会话；平台与 UI 范围按报告证据声明。

架构依据：[ADR 0001](decisions/0001-host-lifecycle.md)、[ADR 0002](decisions/0002-client-remote-lifecycle.md)。候选交互在[设计提案](design-proposal.md)，精确 SDK 事实在[接口调研](research/current-dsh-interfaces.md)。
