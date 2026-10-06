# ADR 0002：客户端使用严格 Typert 合约与动态 namespace 消费者

状态：已采用，客户端切片。目标 SDK：DSH 0.2.0-rc.2。

## 背景

Host 已提供可恢复的归档回收站。客户端需要复用同一 Interface，遵守宿主鉴权、共享 React/native primitives、公开槽位所有权与插件卸载。外部包不能依赖宿主 monorepo 的生成器路径；实际插件 fiber 对 dotted namespace 的依赖检查也比根 Context 严格。

## 决定

通过公开 `TypertContribution` 和 `InvocationDescriptor` 手工注册严格合约，Host 使用 `TypertRemoteService` 绑定已有 Module。参数、结果及完整目录快照共用现有 schema；不建立自定义业务 HTTP 路由，不用未定义的 SRC 回退替代严格客户端投影。

客户端先 `$mount` 合约，再创建声明 `remote.sessionBin` 和原生依赖的动态消费 fiber。字典、样式、槽位、模型订阅全部在消费者生命周期内。避免在提供 namespace 的外层提前静态等待自身服务，也不绕过 Cordis 的依赖检查。

目录通过 Gateway 的重连 stream 每代完整替换。未知变更结果先查同一操作身份的回执；浏览器会话存储保存执行前的计划，显式重试只重发同一计划，Host 继续复核并保障幂等。客户端撤销与批量选择绑定条目身份，不能将后续到达或重建的对象纳入旧操作。

构建输出 DSH lazy factory，自动 JSX runtime 与 React/native primitives 外部化到平台基线；特有 CSS Modules 由 fiber 和 Module Loader 标记共同管理。用实际产物执行与真正独立 Web profile 分层验证，根 Context 或纯 DTO 测试不能替代插件加载和视觉检查。

## 影响

手工描述符需要与 schema 一起维护；动态消费者使卸载及服务撤销能正确释放 UI。API取消不撤销已进入 Host 的持久化操作，未知结果会限制新请求。浏览器禁止会话存储时不能承诺跨页面重载保留。恢复、lease 和未观察归档变化的限制继续遵循 [ADR 0001](0001-host-lifecycle.md)。

正式接口见[客户端接口](../client-interface.md)，实际证据见[客户端验证](../verification/client-interface.md)。
