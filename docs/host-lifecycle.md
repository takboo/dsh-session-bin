# Host 回收站生命周期

本文说明归档型回收站的 Host 操作协议、持久化规则和并发边界。对应传输与界面见[客户端接口](client-interface.md)，运行证据见[Host 验证](verification/host-lifecycle.md)和[客户端验证](verification/client-interface.md)；实现状态集中在 [README](../README.md)。

## 公共接口

Host 消费者注入 `sessionBin`，通过 `ctx.sessionBin` 调用以下方法。所有对象都是独立快照；会话身份不会变成客户端提供的文件路径。

| 方法 | 行为 |
| --- | --- |
| `prepare({ action, sessionId, operationId? })` | `action` 为 `bin` 或 `restore`；返回归档状态、条目身份和阻止原因。默认生成新的操作身份，不执行原生变更。 |
| `execute(plan)` | 重新检查原生状态、会话存在性、活动与所有权，再执行准备的对象；返回 `success`、`rejected` 或 `conflict`。 |
| `list()` | 对账后仅返回本插件仍拥有的回收站条目，普通原生归档不计入。 |
| `getOperation(operationId)` | 查询已保存的操作阶段与结果，适合断线后确认完成状态。 |
| `operations()` | 查询保存的操作记录，发现中断结果；记录包含原始计划和条目快照。 |
| `reconcile()` | 归档部分只修复插件元数据；删除部分仅恢复已保存且匹配的 owner admission 操作，规则见下节。 |

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

## Host 单项删除协议消费者

[删除合约](../src/operations/retirement.ts)与[协调器](../src/host/retirement.ts)提供 Host 专用切片。**默认 DSH `0.2.0-rc.2` 组合没有获准的资源 owner，不执行原生永久删除。** Config 没有启用开关；owner 自报能力也不会获得资格。当前严格 Remote、客户端菜单和确认界面不暴露这些方法，原 `bin/restore` 的 v1 DTO 不变。

| Host 方法 | 行为 |
| --- | --- |
| `preparePurge({ sessionId, operationId? })` | 返回绑定 exact entry/lifecycle/owner/资源清单的单项计划及 blockers，不清除资源。普通原生归档返回 `not-in-bin`；默认组合返回 `permanent-deletion-unsupported`。 |
| `executePurge(plan)` | 重查持久化条目、生命周期、资源范围和活动，在可信 owner 的准入围栏内提供一次性授权；回执区分 `success/rejected/conflict/pending-recovery/partial-failure`。 |
| `getPurgeOperation(operationId)` / `purgeOperations()` | 读取删除 journal 的独立快照；既有 `getOperation/operations` 继续只返回归档操作。 |
| `reconcilePurge()` | 查询相同已保存操作，恢复可信且匹配的 owner 已 admission 工作，再收敛插件元数据。 |

原 `session_bin` domain、条目和历史操作保持 v1；公开 SDK 无 domain 数据迁移，未直接提升版本。新 `session_bin_purge` v1 保存 `bindings` 和 `operations`。生命周期见证只在有获准 owner 的新移入过程中捕获，按不可重用的 `entryId` 绑定，并在条目提交前复核；旧条目不按当前 Session ID 自动补见证。绑定版本目前固定为 1，记录不可替换；恢复后重新移入生成新的 entryId 和见证。日志暂不裁剪。

`operationId` 在两个 journal 间统一认领；同一 ID 改动作、entry、生命周期、owner 或资源清单会拒绝。清单使用稳定 SHA-256 摘要，资源 key 唯一且只能来自声明的参与者；done 必须逐资源确认与 disposition 一致。共享保留须列出其他存活生命周期见证和原因，协调身份须明确保留，不能把缺失的资源回执或 failed 当作整体成功。返回类型校验仅验证协议，资源归属真实性仍依赖 owner 的独立资格及验收。

Host 阶段为 `intent → authorizing → owner-pending → done`。`authorizing` 保存随机 grant nonce，是授权尝试而非 owner admission：请求本身不包含 nonce，最终复核通过后 callback 才将 grant 返回 owner。admitted owner 回执须包含同一 nonce、原始请求及资源清单；拒绝回执的 nonce 为 null。callback 只能使用一次，owner 调用结束后撤销新调用并等待已开始 callback 排空，避免迟到写入覆盖回执或在 lease 释放后继续访问 domain。

owner 的 `fenced/quiesced/erasing/converging/done` 和逐资源回执由资源所有者持久化。Host 观察到可信 admission 后，**先保存见证再调用 recover**，防止后续 I/O 错误丢掉保护。owner done 也先保存，再只删除仍匹配的插件 entry，最后提交 Host 成功回执；此处不要求原生日志仍存在或归档仍为 true。完整已保存 owner done 在 owner 不可用时也能只补插件元数据，旧回执不会操作后来相同 Session ID 的新条目。

未完成删除的 journal 是持久化 guard，阻止普通恢复、新移入及其他同会话删除。原生归档帧继续即时捕获失效；guard 存在时普通归属对账不提前清理 exact entry。owner 缺席、变更、查询故障、回执不匹配或阶段/资源确认回退不能释放 guard；只有同一可信 owner 明确返回 null 且 Host 尚未观察过 admission，才结束为中断冲突。未知 owner/sidecar/元数据 I/O 错误会暂停整个 Module，即使外部将错误包装为业务错误类，也必须重开处理。

普通 prepare/list 与归档帧仅查询进度和补已确认元数据，不调用 owner recover 清除资源。启动、显式 reconcile/reconcilePurge 及同计划显式重试只恢复已保存的相同 owner 操作，不从插件 intent 新发删除，也不重新选择目标。

### 可复用资源 owner 协调

[Owner 协调器](../src/host/retirement-owner.ts)将阶段推进从测试 helper 提炼为正式实现，[owner journal](../src/host/retirement-owner-store.ts)在独立 `session_bin_retirement_owner` v1 domain 中原子保存 public state、逐参与者 fence/quiesce/converge 确认、生命周期排空/完成确认和阻止原因。能力 descriptor 与参与者集合、版本绑定后不可切换；回执、成功资源确认和阶段不允许倒退。

它通过公开定义的生命周期 port 与资源 participant 调用实际资源所有者；这些是本项目的接入契约，不是当前 SDK 已提供的 native Service。default Service 仍不挂载 owner。接入组合必须独立证明这些端口覆盖实际 create/resume/read/write/visibility、writer/读取引用、持久化资源及派生存储；实例化协调器或声明 capability 不构成资格。

| 端口 | 契约 |
| --- | --- |
| `lifecycle.inspect/acquire` | inspect 只读；普通 scope 排他地复核当前生命周期及活动，维护 scope 绑定已保存 exact operation，可在日志已消失或 finalize 确认丢失后恢复，不能重建旧 Session；每次恢复须重新取得所有参与者当前 runtime 排他权/租约，过去的 quiesce 确认不能替代它。 |
| `bindGuards` | 对正常新请求、保留引用和晚到缓存写入安装同一持久化保护；返回的 disposer 必须禁用其路由/引用，不能使它们变成无 guard。初始化完成前不开放请求。 |
| `participant.manifest/fence/quiesce/applyResource/converge` | 每个参与者只报告自己的资源，所有参与者确认 fence 和排空后才能清除；资源动作、收敛和 scope finalize 按同一 operation/lifecycle/resource/revision 幂等。 |
| barrier boolean | `true` 表示已确认完成，`false` 为已知等待并保留阶段/guard，抛错为未知结果并暂停。没有资源行的参与者也不能省略其屏障。 |
| `canAdvance` | 每个持久化确认后检查预算；暂停返回已保存进度，不撤销 durable fence。只有明确恢复推进后续动作。 |

Host 将完整冻结清单作为可选第三参传给 `retire`；已有二参 owner 可忽略它。新协调器对新操作要求完整清单，在任何 grant/fence 前复核请求摘要、生命周期和 descriptor。准备后的范围、生命周期或活动变化用旧冻结清单记录拒绝，grant 为 null、资源回执为空。排空可能发布既有缓冲写入或新代际；排空后清单变化会保留 quiesced fence 和 `blockedReason`，不自动扩大删除范围，需要资源所有者维护处理。

顺序为 owner fence 落盘 → 全部 participant fence 确认 → 生命周期及全部 participant 排空确认 → 逐资源效果与回执 → 全部 participant 收敛确认 → 生命周期 finalize 确认 → owner done。effect 成功但 acknowledgement 未落盘时，只能在已保存冻结操作的维护 scope 中幂等续办。初始化、prepare、inspect、getOperation 及历史 done 不隐式推进资源清除。

guard 除了查询 journal，还检查 initializing、closing 和 sticky failure；任何未知 I/O，包括 falsy rejection，都立即拒绝旧引用和新 generation，不能从可能过期的 memory 推断没有 fence。进行中的 admitted phase 阻止同 SID 新代际；done 对 exact 旧 token 保留永久 tombstone，新 token 可创建；rejected/conflict 不永久封住 SID。每个等待结束及下一动作前重新检查故障和参与者版本。

维护队列使用私有异步上下文，已入队授权观察可完成 close-drain；外部正常路由继续拒绝 closing。独立 control-plane inspect 不重入队列，但关闭会等待其完成。scope/disposer 成功返回后先接管 cleanup，再做健康复核；任何未知错误先暂停，再释放 scope，release 失败与原错误聚合。最终排空初始化、维护请求与观察，禁用所有 guard 路由，再关闭 owner journal。

[参考 owner](../tests/helpers/retirement-owner.mjs)现在仅实现独立测试资源的端口，实际调用该协调器，不再自行推进 phase。它不删除 native JSONL、Workspace、索引、锁或附件；运行证据与仍缺的原生能力见[Host 验证](verification/host-lifecycle.md)。

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
