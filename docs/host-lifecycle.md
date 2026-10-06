# Host 回收站生命周期

状态：首个 Host 实现切片；无 Client 面板或 Remote 传输，也不提供永久删除。包保留 `private: true`，仅在隔离测试宿主验证，不能作为已发布产品安装说明。

## 公共接口

Host 消费者注入 `sessionBin`，通过 `ctx.sessionBin` 调用以下方法。所有对象都是独立快照；会话身份不会变成客户端提供的文件路径。

| 方法 | 行为 |
| --- | --- |
| `prepare({ action, sessionId, operationId? })` | `action` 为 `bin` 或 `restore`；返回归档状态、条目身份和阻止原因。默认生成新的操作身份，不执行原生变更。 |
| `execute(plan)` | 重新检查原生状态、会话存在性、活动与所有权，再执行准备的对象；返回 `success`、`rejected` 或 `conflict`。 |
| `list()` | 对账后仅返回本插件仍拥有的回收站条目，普通原生归档不计入。 |
| `getOperation(operationId)` | 查询已保存的操作阶段与结果，适合断线后确认完成状态。 |
| `operations()` | 查询保存的操作记录，发现中断结果；记录包含原始计划和条目快照。 |
| `reconcile()` | 只修复插件元数据，报告已完成对账、需要重新准备的中断操作和已退出的条目。 |

同一个操作身份绑定同一动作、会话和准备时状态；不同参数使用旧身份会被拒绝。已完成结果是历史回执：旧移入请求在恢复后再次提交只返回旧结果，不会再次移入。拒绝结果也保留；状态变化后应重新 `prepare` 并使用新身份。计划中的阻止原因仅供展示，执行会重新检查，不依赖调用方提交的判断。

## 持久化协议

`session_bin` domain 的 `entries` 表保存插件自有条目，`operations` 表保存日志与回执。通过公开 `storageDomain` 写入；每次写入入口用 Zod 校验并生成快照。两张表与原生归档之间没有事务。

正常移入顺序：检查 → 保存 `intent` 和原状态 → 使用原生归档（不请求停止工作）→ 保存 `applied` → 提交条目 → 保存 `done` 回执。已归档对象仍单独检查活动和存在性，因为原生幂等归档会跳过这些检查。原归档状态保存在 `wasArchived`；恢复只为插件新归档的对象调用取消归档，原先已归档的对象只退出插件目录。工作区位置由原生接口保留；置顶不自动恢复。

启动及原生归档帧触发的对账不执行归档或取消归档：

- `intent` 尚未持久化确认原生成功，一律结束为 `conflict/interrupted`，保留回执。即使当前布尔状态与执行前相同，也可能是用户已经撤销；重试需新的显式计划。
- `applied` 已持久化确认，在会话存在且原生状态仍符合目标时补完条目提交或退出；不符合则报告冲突，不修改原生状态。
- 观察到取消归档，持久化 `ownershipInvalidated` 后释放对应 `entryId` 的条目。后来重新归档不会重新取得所有权。重启也读取已完成日志的失效标记，补完中断的条目清理。
- 意外存储或原生 I/O 错误会暂停该 Module 的后续请求。原子替换可能已写入文件但返回失败，因此不能继续相信内存快照；需要关闭并重开服务，对账后再决定新请求。

活动默认拒绝移入，包含宿主提供方报告的 turn、subagent、job、schedule；普通操作不会停止它们。取消归档成功不能证明日志存在，恢复前另做存在性检查。活动检查和原生队列仍不与新工作启动形成原子事务，遵守原生接口的保护范围。

## 并发与部署边界

Module 串行处理一个 Host 的请求，包括多个窗口发出的重复操作；首个切片用单并发执行队列。插件在打开 domain 之前，通过公开 `@deepseek-ai/node-addon-system/flock` 取得 lifetime lease；卸载停止接收新请求、继续捕获归档帧、等待在途原生与元数据操作结束，关闭 domain，最后释放 fd。固定锁文件不会删除或替换，并核对规范化路径和 inode。

`coordinationDirectory` 是 Host 配置中的绝对目录，默认使用公开 `resolveDshHome()` 下的 `session-bin`。**共享同一 Bin backend 的组合必须使用同一规范化协调目录。** SDK 没有公开实际 backend root 的查询能力，不能自动证明该约定；不同 DSH_HOME 共享自定义 backend 时必须显式配置同一目录。平台或 native addon 不支持 flock 时加载失败。

支持范围是一个 Host 拥有原生 Workspace 存储，该 Host 可连接多个窗口。lease 拒绝第二个遵守相同目录约定的插件进程，但其他 Host 的原生 Registry 不持有这把锁；不支持多个 Host 同时写同一原生 Workspace 存储。当前运行证据限 macOS ARM64、Node 24.18.1、DSH 0.2.0-rc.2；Linux 的 API 存在不代表已执行验证，Windows 尚不支持此切片。

原生归档只有 ID 集合，没有操作身份、actor 或每个会话的版本。运行时捕获的取消归档再归档会使所有权失效；**插件停用期间、进程死亡期间或观察尚未持久化时的取消归档再归档无法被可靠识别。** `applied` 只能证明某次调用已确认，不能证明当前归档仍属于它。此切片不承诺精确恢复这类未观察变化的归属，也不会用恢复日志自动补偿原生操作。操作日志暂无自动裁剪，规模与保留策略留给后续切片。

## 开发与验证

工具配置在仓库的 [mise.toml](../mise.toml)，实际命令集中于 [package.json](../package.json)。安装依赖使用固定 pnpm、frozen lockfile 和 `--ignore-scripts`；本地可按既有兼容性报告设置 `.local/` 下的 mise 与 pnpm cache。

- `mise run check`：正式源代码对固定 SDK 的严格类型检查。
- `mise run test`：先构建，再运行临时数据上的行为、真实进程中断和锁竞争检查。
- `mise run verify:package`：先构建，离线打包、解包，使用真实 Cordis Loader 激活、卸载并重新激活。
- `mise run verify`：按顺序执行类型检查、构建、行为测试与打包检查。

测试目录由 `.local/lifecycle/` 下随机目录产生，显式配置临时 DSH_HOME、JSON storage root、JSONL root 和协调目录。所有测试会话与故障样本留在这里供检查；测试不连接当前 GUI。打包检查使用仓库锁定的 SDK 依赖作为测试宿主，不等于干净 profile/CLI 安装。实际执行结果与未覆盖范围在[实现验证](verification/host-lifecycle.md)记录。
