# Host 回收站生命周期

本文说明归档型回收站的 Host 操作协议、持久化规则和并发边界。对应传输与界面见[客户端接口](client-interface.md)，运行证据见[Host 验证](verification/host-lifecycle.md)和[客户端验证](verification/client-interface.md)；实现状态集中在 [README](../README.md)。

## 原生归档公共接口

生产 `ctx.sessionBin` 以原生 `archivedSessionIds` 为成员来源，包含插件安装前或其他原生界面建立的归档。读取公开 Workspace domain 已提交 global 快照并使用 `workspaceDomainState` 校验：锁定 SDK 的 `domain/changed` 先于 Registry 内存投影更新，不能在该帧处理中依赖仍可能过期的 getter。插件不写原生 domain，所有归档变更仍通过 Registry 的公开方法完成。插件不提供新的 `bin` 入口；Archive、活动检查、停止确认和 Undo 由宿主原生交互负责。选定架构见 [ADR 0005](decisions/0005-native-archive-collection.md)。

| 方法 | 行为 |
| --- | --- |
| `prepare({ action: 'unarchive', sessionId, operationId? })` | 返回 v2 固定观察身份、当前归档状态和 blockers，不修改原生状态。 |
| `execute(plan)` | 重新核对当前成员、观察身份、存在性与 pending deletion guard；新版成功始终调用原生取消归档。 |
| `list()` | 返回原生归档集合的 v2 `ArchiveEntry` 快照，旧 Bin 条目不影响成员。 |
| `getOperation(operationId)` | 返回新版回执或旧 v1 历史操作；同 operationId 不得跨协议复用。 |
| `operations()` | 列出新版取消归档 journal；旧记录通过 `getOperation` 按身份查询。 |
| `reconcile()` | 保守补齐已确认元数据，未确认意图结束为中断冲突；不补偿、重放归档或取消归档。 |

独立 `session_archive` sidecar 保存观察记录和新版取消归档 journal；原 `session_bin` 及 `session_bin_purge` 保持原有 schema，兼容对账不改变原生状态。观察记录的 UUID 是插件看到的集合成员身份，不是 native archive generation、创建时间或 exact lifecycle。列表不显示推测的归档时间。每次写入先校验并快照，继续遵守 domain 无跨表事务和 pinned SDK 写入校验差异。

取消归档顺序为复核 → 持久化 intent → 再复核固定对象与原生状态 → 调用公开 unarchive → 持久化 applied → 完成回执。旧条目的 `wasArchived` 不参与新动作。会话已缺失时明确拒绝；原生 unarchive 的幂等返回不被当成日志存在证明。工作区成员及位置、取消归档不恢复置顶的语义由原生接口保持。

原生归档帧立即捕获成员退出，避免取消归档与再归档两帧在队列等待期间被最后一个集合覆盖；已观察的重新归档获得新的观察身份，旧计划冲突。原生集合没有持久化代际，无法可靠识别插件停用、进程死亡或观察尚未持久化期间的 ABA。固定选择和历史幂等不意味着弥补这个宿主缺口。

旧 v1 execute 兼容路径只查询或完成已有日志的保守对账，不能开始新的旧归档/恢复。新严格 Remote 仅接受 v2 `unarchive`；浏览器旧 pending 缓存只查询历史回执，不重发未知旧请求。所有请求由 Host 排队并在卸载时 drain；新旧 journal 共用 operationId 和 pending deletion guard，不能通过新取消归档绕过已开始的 retirement。

生产组合按已审计 SDK 指纹和实际资源提供方检查启用版本绑定的冷 JSONL 单项永久删除；未知组合或 `permanentDeletion: false` 继续拒绝。归档观察不调用删除绑定 capture，也不按当前 Session ID 给旧条目自动补 exact lifecycle。显式准备、执行与同操作恢复遵守下述授权合约；真实 Adapter 接入见 [ADR 0007](decisions/0007-native-jsonl-deletion-adapter.md)。

## 原生归档单项删除准备与授权

`ArchiveModule` 在自身队列、未知故障暂停和 lifetime lease 下复用删除消费者及 owner 协调器。生产 `ctx.sessionBin.preparePurge` 创建 **v2 原生归档目标计划**，支持组合返回 exact lifecycle 与冻结资源清单；未准入组合返回 `permanent-deletion-unsupported`，非成员返回 `not-archived`。单项删除已向严格 Remote/UI 开放，旧 v1 仅保留历史查询与对应 Host 兼容恢复。绑定方式见 [ADR 0006](decisions/0006-native-archive-retirement-binding.md)，实际 Adapter 见 [ADR 0007](decisions/0007-native-jsonl-deletion-adapter.md)。

显式 `preparePurge` 是获取新原生生命周期见证的唯一入口：先固定当前观察条目，复核成员、已观察失效与 pending guard，再由独立获准 owner 提供 exact `{storeId, sessionId, lifecycleId}` 和 descriptor，保存不可替换的 v2 binding。binding 明确标记 `target: 'native-archive'`、`entryVersion: 2`；owner request 的 `bin` 字段保留兼容字段名，但 v2 必须另有 `kind: 'native-archive'`。旧 v1 binding 和 request 形状不变，不能以观察 UUID 套用旧删除授权。

准备返回完整冻结资源清单，并在 owner inventory 的等待后再检查固定观察与 lifecycle。执行重新检查持久化 binding、原生成员、活动、owner/参与者 descriptor 和清单摘要；owner 在自己的联合 admission scope 内调用一次性 Host callback，再复核这些条件后才取得 grant。客户端删改 blockers 不能绕过检查。准备没有资源清除效果，绑定本身也不是可以脱离固定计划执行的授权。

观察 UUID 仍只代表插件观察身份。相同观察的 lifecycle binding 不自动替换；owner 身份或生命周期改变会拒绝旧计划，也不按当前 SID 补写旧见证。显式重新准备可冻结新的资源清单，但不得替换已绑定的 lifecycle。成员已被观察到退出后再归档才得到新的观察身份；未观察 ABA 的原有限制不变。

原生接入仍须由 Host composition 提供独立 `verifiedNativeArchive` 准入，旧 Bin `verified` 或 owner 自报不能启用新目标。生产 composition 只为本插件成功构造、通过版本/源码/实例检查的 `NativeRetirementOwner` 提供资格；Host 配置 `permanentDeletion: false` 可关闭，设置 true 不绕过检查。默认 SDK 没有公共 retirement API，本插件通过明确版本绑定实例 Adapter 补齐支持范围内的准入、排空、文件清除与元数据收敛。旧 test-only owner 只清临时 domain，其历史验证不扩大真实 Adapter 资格。

`session_bin_purge` domain 的 storage version 保持 1，schema 严格接受原封不动的旧 v1 记录和明确标记的新 v2 记录；不执行数据迁移、补绑定或原生归档变更。journal、plan、entry、binding 和 owner request 的目标版本必须一致；未完成记录只能交给对应目标消费者恢复。已完成历史回执只返回原结果，owner done 后只清理匹配的 exact 观察条目，不触碰同 SID 的后来条目。

新旧 pending journal 都阻止新版取消归档和同 SID 的新删除。原生 pending 持有原观察元数据，观察到退出时列表仍按当前原生成员隐藏它，重新归档也不能替换受保护对象。旧 pending 只施加动作 guard，仍允许生成惰性的新版观察行，保持原生成员完整。普通列表、准备和帧对账不调用 owner recover；显式 `reconcile/reconcilePurge` 和启动只续已保存的可信同操作。组合在同一已接受请求寿命内恢复新旧 journal，并排空两个消费者后统一关闭共享 retirement domain，最后释放 lease。

## 真实冷 JSONL 单项删除 Adapter

`NativeRetirementOwner` 自行拥有被明确 adoption 的会话记录删除生命周期。当前默认生产资格限已实际验收的 DSH `0.2.0-rc.2`、Node `24.18.1` / libuv `1.52.1`、Windows x64、macOS ARM64/Intel、Linux ARM64/x64、单 Host，以及独立验证通过的 JSONL raw/zstd、已知 Workspace/JSON domain、已启用 SQLite 查询与投影 cache 组合；确认没有相应 optional provider 的最小组合也可使用。未验收的平台/架构（包括 Windows ARM64）不因 Adapter 存在或 Host 配置 true 自动获得生产资格。正在初始化的 provider 会先等待，unknown/disabled/path 或实例漂移不伪称不存在。SDK 所有参与包版本与源码 SHA-256 固定于 `native-retirement-sdk`；变更组合需独立验收。支持的是会话日志和声明的会话元数据/派生索引，共享附件、外部工具副本和独立 fork 保留，不做全局 GC 或安全擦除。

准入只接受原生归档的冷目标，拒绝 live Session/Agent、turn/job/subagent/schedule、尚未释放的 SessionHandle、query lease、history follower、cache dirty 和迁移准备。不能识别目标的安装前 follower 保守拒绝；不隐式停止其他会话。实例 guard 保留 Cordis caller shadow context，覆盖原生 Workspace 队列执行与写入前复核、SessionStore 准入、JSONL create/open/低层读写、cache 实际 put、完整 query/SQLite queue。全局 header/historical-corpus 读帧在执行前排空，新普通扫描等待 scope 释放，防止跨 SID 历史读取与删除相互等待；其他 SID 的既有 current writer 不被本次删除停止。

`session_bin_jsonl_resources` 保存 durable store/root/fingerprint 和 exact lifecycle nonce、最低既存 canonical anchor、完整文件 identity/digest、metadata medium/memory/location 快照。这个 nonce 是本插件 Adapter 提供的逻辑生命周期，不能描述为原生格式字段。显式准备固定这些证据；已退役 SID namespace 不重用，历史请求只处理原 token。`session_bin_jsonl_retirement_owner` 保存协调器 journal，恢复不从当前 SID 重建新目标。

`NativeJsonlFiles` 对每个待清文件确认规范布局、真实根/目录身份、常规文件 inode/birthtime、size/timestamps 和全 bytes SHA-256；ino 或 birthtime 无有效值时拒绝，不能用零值猜测 incarnation。清单覆盖 canonical V0–V4 及可识别的 materialization/migration staging。POSIX 只使用已存在的空常规 `session.lock` 取得同 inode 排他权，不 open writer 迁移、不新建/替换锁；Windows 清单明确保存 SDK 的路径派生 semaphore 名字，不要求或创建锁文件，路径别名不能令 SDK 与插件取得不同名字的锁。额外 hard link 以实际 fstat 复核，symlink/junction、重复 SID、多编码、未来代、flat layout、未知目录/文件或不完整 header 均明确拒绝。POSIX 文件动作只 unlink 冻结的直接 child basename 并 fsync 目录；Windows 对同一独占已确认文件先 truncate(0) + FD sync、关闭 FD，再 unlink 和确认缺失，只有已保存 admission 的同操作维护 scope 能续办同一空文件。release join 已接受动作后才释放内核租约，目录、协调身份和共享存储不删除。假设可信稳定祖先、协作单 Host 和 Windows 同登录会话，不提供恶意 namespace 替换或其他 Host 的完整排他保证。

metadata participant 在文件清除后定点移除冻结 Workspace account 和原生 archive/pin/header 观察，保留其他当前字段。cache 的支持边界为已知 `session_projcache` v7 / PerRecordJsonUnit / KvTableImpl：检查实际受控 JSON 文档、真实 FD 硬链接数与内存摘要，不能从 memory 缺行推断物理缺失。POSIX 在原写链内删除目标文档并同步目录；Windows 按原 exact request/lifecycle/冻结快照派生专属非 JSON stage，先进行无 replace/copy 的同卷 write-through rename，再核对原 inode/birthtime 与摘要、清零并同步、关闭 FD、删除并确认 stage 和原名都缺失，最后才清内存和发布普通通知。陌生 stage、身份/内容漂移、旧 whole-unit bootstrap 源明确拒绝。SQLite 使用其自身公开 search 的对账事务清除目标派生行，不直接编辑私有 SQL 索引。资源 effect 确认先于 erased 回执，全部参与者、生命周期 finalize、owner done 完成后才提交 Host 成功；原生 `api-session/removed` 只是最后展示通知。

维护权限使用可撤销 token。Domain/API 通知与普通 activity callbacks 没有维护权限，不能通过同步/迟到 observer 重新创建已退役数据。直接 owner 控制面观察、临时 FD、已接受读写与协调器维护都由 close join；关闭开始后拒绝新 target/global 请求，等待 scope 的请求在醒来后再复核 closing，已接受完整 frame 的嵌套读写仍须排空，frame 结束后其权限立即失效。已知拒绝不暂停，未知 I/O 暂停 owner/Module并保护受影响目标，需完整重开对账。卸载保留 pending/done 的窄 SID 围栏；同 SDK 实例重启插件时，只允许匹配 durable store/root/fingerprint 的已关闭 owner 被接管，旧 callable aliases 撤销，原实例方法同步替换为新 guard。未 admission 的旧失败候选由可信新 epoch 保守释放，不能永久遮蔽正常日志。

## 旧 v1 Bin 合约与日志兼容

下列独立目录、`bin/restore` 及 `wasArchived` 描述的是保留的旧 core、日志格式和测试资源 owner 协议。生产入口已切换到上面的原生归档模型；这些旧规则不决定新面板成员，也不开放新的旧归档操作。

### 旧公共接口

旧切片的 `SessionBinModule` 暴露以下 v1 方法；生产 `ctx.sessionBin` 使用上面的原生归档接口。所有对象都是独立快照；会话身份不会变成客户端提供的文件路径。

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

[删除合约](../src/operations/retirement.ts)与[协调器](../src/host/retirement.ts)继续提供新旧目标消费者。生产组合的真实冷 JSONL 支持、配置与严格 Remote 已在上节说明；以下保留 v1 Bin 和通用 owner 协议，不以旧默认无 owner 的历史状态覆盖现状。owner 自报不能获得资格，legacy `bin/restore` DTO 不变，生产归档观察不产生删除绑定。

| Host 方法 | 行为 |
| --- | --- |
| `preparePurge({ sessionId, operationId? })` | 旧 `SessionBinModule` 返回 v1 exact Bin/lifecycle/owner/资源清单计划；普通原生归档返回 `not-in-bin`。生产 `ctx.sessionBin` 创建上文 v2 原生计划；支持组合可执行，未准入或显式关闭组合返回 `permanent-deletion-unsupported`。 |
| `executePurge(plan)` | 重查持久化条目、生命周期、资源范围和活动，在可信 owner 的准入围栏内提供一次性授权；回执区分 `success/rejected/conflict/pending-recovery/partial-failure`。 |
| `getPurgeOperation(operationId)` / `purgeOperations()` | 读取删除 journal 的独立快照；既有 `getOperation/operations` 继续只返回归档操作。 |
| `reconcilePurge()` | 查询相同已保存操作，恢复可信且匹配的 owner 已 admission 工作，再收敛插件元数据。 |

原 `session_bin` domain、条目和历史操作保持 v1；公开 SDK 无 domain 数据迁移，未直接提升版本。`session_bin_purge` storage version 1 保存 `bindings` 和 `operations`，兼容 v1 与 v2 record。旧 core 的生命周期见证仍只在有获准 owner 的新移入过程中捕获，按不可重用的 `entryId` 绑定，并在条目提交前复核；旧条目不按当前 Session ID 自动补见证。原生 v2 的显式准备绑定遵守上节独立规则。两种记录各自不可替换，日志暂不裁剪。

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

Module 串行处理一个 Host 的请求，包括多个窗口发出的重复操作；首个切片用单并发执行队列。插件在打开 domain 之前取得 lifetime lease：POSIX 使用公开 `@deepseek-ai/node-addon-system/flock`，Windows 使用独立路径派生内核信号量。协调目录和既有空常规 marker 会在排他取得后复核身份，不删除或替换 marker，不按 PID/过期抢占。卸载停止接收新请求、继续捕获归档帧、等待已接受的完整原生与元数据请求结束，关闭 domain，最后释放内核租约及 FD。

`coordinationDirectory` 是 Host 配置中的绝对目录，默认使用公开 `resolveDshHome()` 下的 `session-bin`。**共享同一 Bin backend 的组合必须使用同一规范化协调目录。** SDK 没有公开实际 backend root 的查询能力，不能自动证明该约定；不同 DSH_HOME 共享自定义 backend 时必须显式配置同一目录。平台或 native addon 不支持 flock 时加载失败。

支持部署模型是一个 Host 拥有原生 Workspace 存储，该 Host 可连接多个窗口。lease 拒绝第二个遵守相同目录约定的插件进程，但其他 Host 的原生 Registry 不持有这把锁；不支持多个 Host 同时写同一原生 Workspace 存储。默认删除资格按已实际验收组合开放；candidate 与生产支持状态分别记录，不从底层 API 或代码存在推导已支持。Windows 信号量限定同登录会话，与 WSL/Cygwin、不同登录会话或其他提供方的协调不在声明范围。正式发布要求三类主要 OS 全部通过对应验收，见[分发与发布](release.md)。

原生归档只有 ID 集合，没有操作身份、actor 或每个会话的版本。新版运行时捕获的取消归档再归档会更换观察身份；旧 core 对相同变化使所有权失效；**插件停用期间、进程死亡期间或观察尚未持久化时的取消归档再归档无法被可靠识别。** `applied` 只能证明某次调用已确认，不能证明当前归档仍属于它。此切片不承诺精确恢复这类未观察变化的归属，也不会用恢复日志自动补偿原生操作。操作日志暂无自动裁剪，规模与保留策略留给后续切片。

## 开发与验证

工具配置在仓库的 [mise.toml](../mise.toml)，实际命令集中于 [package.json](../package.json)。安装依赖使用固定 pnpm、frozen lockfile 和 `--ignore-scripts`；本地可按既有兼容性报告设置 `.local/` 下的 mise 与 pnpm cache。

- `mise run check`：正式源代码对固定 SDK 的严格类型检查。
- `mise run test`：先构建，再运行临时数据上的行为、真实进程中断和锁竞争检查。
- `mise run verify:package`：先构建，离线打包、解包，使用真实 Cordis Loader 激活、卸载并重新激活。
- `mise run verify`：按顺序执行类型检查、构建、行为测试与打包检查。

测试目录由 `.local/lifecycle/` 下随机目录产生，显式配置临时 DSH_HOME、JSON storage root、JSONL root 和协调目录。所有测试会话与故障样本留在这里供检查；测试不连接当前 GUI。打包检查使用仓库锁定的 SDK 依赖作为测试宿主，不等于干净 profile/CLI 安装。实际执行结果与未覆盖范围在[实现验证](verification/host-lifecycle.md)记录。
