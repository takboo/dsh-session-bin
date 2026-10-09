# DSH Session Bin — 设计提案

本文记录已选定的产品范围、候选交互、模块边界和能力准入条件，不作为开发进度表。设计依据为 2026-10-06 调研的 DSH `0.2.0-rc.2`；实现状态见 [README](../README.md)，正式协议见[Host 生命周期](host-lifecycle.md)和[客户端接口](client-interface.md)，运行证据见[客户端验证](verification/client-interface.md)。

## 已选定的原生归档产品模型

2026-10-07 根据已安装插件的实际体验反馈，确定以 Harness 原生 Archive 作为唯一归档入口和管理集合。插件直接展示原生已归档会话，提供元数据搜索、工作区筛选及单项/固定选择的取消归档；移除自建 `Move to Session Bin` 菜单、独立目录成员条件和重复 Undo。这个产品模型已经选定；正式实现和兼容边界见[Host 生命周期](host-lifecycle.md)及[客户端接口](client-interface.md)。

新模型不要求用户先经过本插件操作才能管理原生归档。原生归档集合是列表成员依据；插件元数据可用于观测身份和操作回执，不再决定归档是否属于管理范围。旧 v1 条目及历史回执须兼容处理，启动或迁移不得自动改变 native archive 状态；新的“取消归档”不沿用旧 `wasArchived` 恢复语义。

观察到原生归档不等于获得永久删除授权。准备和执行删除仍须明确确认固定对象、复核当前归档成员及 exact lifecycle，并通过资源所有者的独立准入。原生集合没有归档时间/代际 token，不能将首次观察时间显示为真实归档时间，也不能承诺识别未观察的取消归档再归档。

下文独立 Bin 入口、目录所有权及相关交互作为旧方案/已实现切片的背景保留，不是新产品模型的要求；资源生命周期、活动保护、共享资源、单 Host 和删除验收约束继续适用。

## 首次公开发布范围

首次公开发布包含围绕原生归档的手动核心闭环：原生 Archive、归档管理与取消归档、单项永久删除、固定选择的批量永久删除及明确对象范围的清空。永久删除独立验收通过后，再准备公开分发；Windows、macOS、Linux 三类主要平台均须有明确宿主版本、架构、文件系统及存储提供方的删除行为、资源生命周期和故障恢复证据。跨平台锁与文件操作须遵守各平台的实际宿主契约，未验收组合不得自动启用删除；具体发布条件见[分发与发布](release.md#首次发布完成条件)。日志预览、自动定期清空与跨设备同步不作为这一核心闭环的首发条件。

所有删除目标须在准备与执行时核对当前原生归档成员、固定快照和生命周期身份；归档观察本身不授予删除权限；当前已选择并实现 [ADR 0007](decisions/0007-native-jsonl-deletion-adapter.md) 的版本绑定冷 JSONL 单项 Adapter，未审计组合继续拒绝。批量与清空在操作开始时固定条目集合，期间新增或重新创建的条目不进入该批次。确认展示实际对象数、不可逆语义与阻止原因；结果按对象报告，失败和未知结果可查询，重试重新检查状态。

删除准入依赖独立已验证的资源生命周期协议；可逆归档的日志、lease 与恢复证据不能替代。未支持的版本或提供方拒绝删除。不能直接删除会话目录、锁文件、共享附件或私有索引来补齐能力；共享资源按已验证的引用归属规则处理。接口与已发布参考实现的事实见[永久删除调研](research/permanent-deletion.md)。

## 定位与差异

暂定 npm 名称 `dsh-session-bin`，显示名“会话回收站 / Session Bin”。名称可用性和最终 GitHub 仓库地址在建立远程仓库前核对。

参考项目已经提供回收站、恢复、预览及批量永久删除。当前 DSH 也已提供归档、撤销、归档筛选和内容搜索。新项目的价值应落在：原生扩展槽位、清晰的回收站所有权、面向大量会话的批量整理、完整的活动保护，以及可验证的兼容性。具体事实与来源见[参考及分发调研](research/reference-and-distribution.md)和[当前 DSH 接口调研](research/current-dsh-interfaces.md)。

新实现优先使用宿主接口和控件；`Seetraum/harness-session-delete` 采用 MIT 许可，其他参考实现按各自许可证处理，实际复用的部分保留相应版权与许可说明。原生归档行为的全局改写不作为实现基础。

## 旧 Bin 切片背景：操作语义

- **归档**：由 DSH 管理的可逆隐藏，保留会话日志及工作区位置。
- **移入回收站**：通过原生归档隐藏会话，同时持久化本插件的回收站条目。只有有本插件条目的会话属于本插件回收站。
- **恢复**：恢复移入前的归档状态，再完成本插件条目的状态变更。由本插件新归档的会话调用原生取消归档；移入前已经归档的会话恢复后仍保持归档。保留宿主的工作区位置语义；原生归档清除的置顶状态不自动恢复。
- **永久删除**：清除会话持久化内容及相关记录。当前公开接口缺少完整能力，必须先证明指定宿主版本与存储提供方可安全支持，才能向用户提供该操作。

原生归档与回收站分开显示。已有归档会话只有经用户选择“移入回收站”才获得本插件条目。“清空回收站”仅处理操作开始时明确选定的条目；期间新增的会话不进入该批次。

## 交互与视觉

入口放在原生会话行的菜单和侧边栏全局面板；回收站面板通过公开槽位注册。设置页只放偏好与兼容性说明。会话行的快捷图标属于后续增强，确保键盘聚焦也能发现。

面板采用轻量列表：顶部为标题、计数、搜索和工作区筛选；正文按会话行展示名称、工作区和移入时间；选择后出现固定的批量操作栏。搜索范围为名称和工作区元数据。只读详情属于候选能力：宽屏可展示选中会话的详情，窄屏可使用宿主 Modal；日志内容预览按需加载。

使用宿主 `ui-primitives` 的 Button、Checkbox、Input、Menu、Modal、Toast 与图标，以及 `--dsw-alias-*`、圆角、字体和 elevation 变量。功能样式使用 CSS Modules，浅色、深色和第三方主题由宿主解析；不另建全局调色板。按钮沿用宿主普通 36px、紧凑 28px 的几何。颜色用于状态，永久删除仅在操作上下文使用错误色。

使用宿主 locale 和 shortcut 注册机制。面板支持 Tab、Shift+Tab、Escape、焦点恢复与减少动画设置，搜索输入兼容中文输入法。永久删除的确认默认聚焦取消，列出实际对象数和阻止原因。普通移入回收站提供撤销；只有宿主已确认持久化成功，才显示成功反馈。

批量结果展示“成功 / 跳过 / 失败”及逐项原因；“重试失败项”重新检查对象状态。失败项继续保留选中，成功项取消选中。空回收站、无搜索结果、连接失败、未支持的宿主能力分别给出明确反馈。

视觉依据：[官方 Web UI 样式规范](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/web-styling.md)；与安装版本对应的控件和槽位细节见接口调研。

## Module 与 Interface

初期使用一个 npm 包，源代码分为 client、host 与操作模型；不提前建立多包 monorepo。

```text
src/
  client/       面板、会话菜单、locale、样式
  host/         宿主注册、操作协调、回收站条目、恢复日志
  operations/   计划与逐项结果的类型和规则
scripts/        构建、打包与兼容性检查
tests/          临时数据上的行为与宿主集成验证
```

上述布局表达模块边界；实际接口与范围以[Host 生命周期](host-lifecycle.md)及[客户端接口](client-interface.md)为准。

核心 Module 是 `SessionBin`。对调用方暴露小的 Interface：查询条目、准备操作、执行已准备的操作。准备结果描述目标、阻止原因与版本；执行时重新检查，避免把预览当成有效授权状态。方法名称和 DTO 是设计建议，不是现有 DSH SDK 声明。

UI 只持有会话身份、操作计划和逐项结果，路径由 Host 解析。原生归档和取消归档集中在 Host Implementation；回收站条目优先使用已查证的 `defineDomain` 与 `ctx.storageDomain.open` sidecar 能力持久化。这使确认流程、面板与快捷操作共享一致规则。

永久删除的 Seam 位于经过验证的存储能力调用处。仅在实际实现 JSONL 提供方支持时增加对应 Adapter；其他提供方返回“暂不支持永久删除”。所有依赖在 Module 构造时接收，测试从同一 Interface 检查结果。宿主变化集中在 Adapter，不传播到 UI。

客户端采用 DSH 的 Module Loader 打包约定，宿主注入 React 与共享 primitives；官方宿主包使用 peerDependencies，编译所需包使用 devDependencies。具体外部模块清单以当前 SDK 和真实加载测试为准。

## 健壮性约束

1. 移入回收站使用原生归档活动检查，默认拒绝原生报告活动的主会话、子代理、后台任务或计划任务；普通回收站操作不隐式停止任务。已归档对象的原生归档调用会幂等返回，Host 必须另外复核活动，不能将返回成功视为静止证明。永久删除须重新检查活动，并证明写锁和保留引用的协调机制；停止请求返回也不代表所有工作已结束。恢复保留移入前的归档状态。
2. 本插件条目采用带 schemaVersion 的持久化状态；每次 `put`、`update` 和全局状态写入先执行本插件的 schema 校验与数据快照。当前版本原生 domain 的无效 `put` 能写入、重开才拒绝，这一差异已在[运行验证](verification/dsh-0.2-compatibility.md)中复现。先记录操作意图，再执行宿主变更，再提交条目；重启按日志和宿主状态对账，恢复中途失败的操作。
3. 使用会话身份串行化同一对象的操作，并给请求赋操作身份。重复提交返回已记录结果；跨窗口或跨进程正确性由宿主提供的协调能力或经验证的锁保证，不能只依赖内存队列。
4. 执行时重新核对会话是否仍在本插件回收站、是否有活动、目标提供方是否匹配。外部取消归档后，条目应对账移除或明确标记冲突，不自动把会话再次归档。
5. 永久删除先设计持久化恢复协议，证明日志、工作区成员关系、归档集合、查询索引及运行时缓存的一致性。删除或隔离前解析真实路径、确认属于提供方记录和允许根目录，验证文件身份；客户端不提交任意文件路径。
6. 批量执行设定有界并发，记录逐项结果。取消只停止尚未开始的对象，已完成的结果仍可查询。断线后先查询操作状态再决定重试。
7. 插件卸载通过 Cordis 生命周期释放槽位、样式、监听和请求。本插件不覆写全局宿主方法。

归档型回收站的日志与协调范围见[Host 生命周期](host-lifecycle.md)及对应验证。永久删除仍须独立证明资源隔离、锁协调、缓存和索引一致性，不能从可逆归档的验证推断删除能力。

## 永久删除资源生命周期候选协议

本节为 **2026-10-07 的完整资源 owner 候选接口方案，尚未获得原生删除 provider 准入**。其中 Bin entry 绑定描述的是旧 core 的消费者与测试 owner；原生归档观察不自动继承这种授权。新原生单项准备已采用显式 v2 binding：固定观察对象，由独立获准 owner 给出 exact lifecycle 与冻结清单，执行及 admission 再复核，正式行为见[Host 生命周期](host-lifecycle.md#原生归档单项删除准备与授权)和 [ADR 0006](decisions/0006-native-archive-retirement-binding.md)。这一消费者与 test-only owner 切片不代表完整 native 组合获得准入。公开 npm DSH `0.2.0-rc.2` 上的 12 项[准入探针](../tests/deletion-admission.test.mjs)复现了资源寿命与身份缺口，不能据此启用删除；结果及精确基线见[Host 验证](verification/host-lifecycle.md#永久删除资源准入探针)。已实现严格的 Host 协议消费者、sidecar、授权 grant 与恢复 guard，并提炼可复用 owner 阶段协调器及逐参与者 journal。正式行为见[Host 生命周期](host-lifecycle.md#host-单项删除协议消费者)，选定架构见 [ADR 0003](decisions/0003-retirement-consumer.md)与 [ADR 0004](decisions/0004-retirement-owner-coordination.md)。完整 public native 资源端口仍缺失；用户已明确选择自行实现，本插件采用 [ADR 0007](decisions/0007-native-jsonl-deletion-adapter.md) 的精确版本/源码/实例绑定 Adapter 补齐冷目标支持。Adapter 使用具体文件身份、同 inode 稳定锁和原生参与者协调，不递归删除目录、替换锁或直接写私有 SQLite 索引。下列候选名称仍不是现有 SDK Service，早期 test-only 结果不代替真实删除验收。

### 身份和范围

需要资源所有者提供可持久化的 `{ storeId, sessionId, lifecycleId }`：`storeId` 标识持久化存储命名空间，`lifecycleId` 在逻辑会话首次创建时生成，跨 resume、重启和格式迁移保持，ID 重新创建必须更换。它与每次进入内存的 exact Session/Agent 对象身份、物理日志代际和变更 revision 分开。`createdAt/cwd` 可由调用方重复指定；persistence 的 `identity: symbol` 仅在进程内有效，`revision` 也不承诺跨实例比较。这些都不能替代上述删除身份。

旧 Bin 条目须在移入时绑定所有者生命周期，计划再绑定 `entryId`、条目版本、`operationId` 与资源清单摘要。原生归档对象采用上文的显式准备捕获，观察本身不带 lifecycle 见证。两种准备及执行都检查对应持久化对象、当前原生成员和所有者身份。原先未绑定的 v1 条目没有这样的生命周期见证，不能在删除时仅凭同名会话自动补齐；已选定的消费者实现保留原 v1 DTO，在新移入时另存 sidecar 见证。兼容方式为继续允许可逆恢复，经明确移入创建新的 entryId 和见证；旧 v1 见证不会自动升级成新原生授权；新冷 JSONL owner 仅通过原生显式准备 adoption 和独立组合准入获得资格。未观察到的取消归档再归档仍遵守现有归属限制，不以新身份方案宣称已恢复历史 actor 信息。

单项指一个明确的插件条目和它绑定的逻辑会话，不隐式级联删除其他 Session。fork 与未选中的子代理会话保留；如果所有者不能证明父子日志、spill 或其他引用可安全分离，则拒绝此目标。将来显式选择的其他会话也须各有插件条目与身份，不能因为 `parentSession/origin` 而获得删除授权。批量及清空固定这些条目身份，不在重试或恢复时扩大集合。

### 资源所有者接口草案

优先由宿主提供统一 retirement 协调入口，persistence、Agent、Workspace、query/cache、attachment/spill 等提供方参与其公开协议。本插件负责条目授权和展示，资源清单、路径校验、关停与删除由相应所有者执行。接口形状建议如下，类型仅表达契约：

```ts
type LifecycleKey = { storeId: string; sessionId: string; lifecycleId: string };
type BinBinding = { entryId: string; entryVersion: number };
type RetirementRequest = {
  operationId: string;
  expected: LifecycleKey;
  bin: BinBinding;
  manifestDigest: string;
};
interface SessionRetirementOwnerV1 {
  capabilities(): Promise<RetirementCapabilities>;
  inspect(sessionId: string): Promise<LifecycleObservation>;
  prepare(expected: LifecycleKey): Promise<ResourceManifest>;
  retire(request: RetirementRequest, authorize: RetirementAuthorizer,
    frozenManifest?: ResourceManifest): Promise<RetirementState>;
  getOperation(operationId: string): Promise<RetirementState | null>;
  recover(operationId: string): Promise<RetirementState>;
}
```

- `capabilities` 说明精确宿主/提供方、durable store 身份、协议版本与参与的资源所有者。所有已启用且可能保留会话数据的提供方必须有已验证的 retirement 能力；未覆盖的组合返回不支持，不能忽略可选插件中的数据副本。
- `inspect` 区分可读生命周期、所有者已认证的不存在、不可读/未支持和观察失败。`stat` 缺省或 `list` 未列出不是不存在证书。无法给旧数据建立精确身份时返回缺口，不生成可执行计划。
- `prepare` 返回无副作用清单：目标生命周期、所有历史/当前代际、独占资源、共享引用、保留资源及阻止原因。摘要覆盖影响确认的资源范围和参与者版本；不含客户端可提交的文件路径。清单变化要求重新准备和确认；不能用旧计划包住后来生成的日志代际。
- `retire` 在宿主的生命周期准入围栏内复核 exact identity、清单和原生活动，并调用 Host 本地 `authorize` 重新核对持久化条目。围栏必须协调会话 create/resume/fork、写入、读取/订阅准入及 native archive/unarchive/pin 的相关变更；不能是另一把只有插件使用的锁。授权失败、活动存在或范围变化在不可逆步骤前返回持久化拒绝/冲突回执，不隐式停止任务。
- `getOperation` 和 `recover` 只处理已保存的同一绑定。旧请求在 ID 重用后返回旧回执或身份冲突；不存在操作返回 `null`，不得清理同名资源后伪造成功。`recover` 不重新解析批量选择，也不把新生命周期绑定到旧操作。

`RetirementAuthorizer` 是宿主调用、只读且可等待的条目核对回调，不是由客户端提供的授权位。Host 提供完整冻结清单的独立第三参数，旧二参 owner 可忽略；新协调器对新操作要求它并在任何 grant/fence 前核对摘要及身份，范围漂移的拒绝仍引用原冻结清单。授权在准入围栏内运行，本插件队列/lease 同时阻止自身恢复或条目替换；已观察的外部归属失效必须被核对。宿主若无法将原生变更与该围栏协调，授权后的 TOCTOU 仍存在，该接口不能准入。

### 生命周期和完成屏障

候选顺序是：插件持久化 intent → 所有者在围栏内最后核对并持久化 retirement intent/fence → 排空 exact lifecycle 的既有使用者 → 验证冻结资源清单 → 所有者清除资源 → Workspace/派生存储收敛 → 所有者持久化完成回执 → 插件核对回执并退出相同 `entryId` → 插件完成回执。

围栏须在任何资源释放或清除前持久化，并在启动时先恢复、再允许 create/resume/读写/索引重建。最终活动检查必须在准入围栏内发生：检查前已准入的 turn、subagent、job、schedule 或 terminal 使用者仍活动时拒绝，不能从归档布尔值推断静止。不得以停止请求返回作为排空成功。quiet live 对象的退出通过它的资源所有者完成，等待 composite disposal、writer `close`、异步观察者和相关在途读请求；仅调用 SessionStore detach 或广播 removed 不满足屏障。已保留 handle、历史 preparation 和订阅须由各自 owner 关闭或持久化失效，此后旧对象的 read/write/缓存写回也须拒绝；不能只禁止新 open 而让已保留对象继续使用。读取快照已经被调用方复制的内容不可能追溯销毁，删除声明不包括外部导出或独立 fork 中已有的副本。

JSONL 所有者在 writer 已关闭后取得相同稳定 `session.lock` inode 的写排他权，并保持到自身资源回执提交；单纯 `open('write')` 会读日志并可能迁移，不是无副作用的 retirement lease。不得删除、移动或替换锁文件及其父目录来改变这把锁的身份。历史/current raw/zstd 代际和 staging 文件由 provider 分类和核对真实文件身份后处理；未知或不可读资源阻止完整成功。retirement tombstone/操作记录应在重新查找和写入路径可见，阻止已缓存路径重新发布。锁及最小 tombstone/回执属于保留的协调元数据，不算未清除的会话内容；ID 重用需新的生命周期及经验证的 admission 规则。

共享附件、命名 hard link、request-image cache 和 spill 按各自所有者的引用规则处理。spill 的 session 目录归组也不证明 bytes 独占：fork 可保留旧 locator。候选结果必须列出已解除的引用、已清除的独占资源、因其他存活引用保留的共享资源及失败项。未知引用按保留/阻止处理，不能扫描不完整的 session 列表后宣称零引用；无公开引用/保留协议时此提供方组合不准入。

Workspace 所有者在其队列内清除该生命周期的成员、archive/pin 和 header 索引，并给出持久化确认；本插件不写其私有表。query/projection 所有者先持久化生命周期失效标记，再排空已开始的写回、清除属于它的派生记录，之后拒绝旧代晚到写入。重建和重开要消费同一失效记录；仅通知客户端、清掉一次 cache row 或等待下一次 SQLite 查询不构成完成。完成回执要求所有必要参与者已确认，后续 native list/search/follow 与重启结果一致。

### 中断、结果及幂等

所有者至少保存 `intent`、`fenced`、`quiesced`、`erasing`、`converging`、`done`，清除与收敛分别记录逐资源确认。phase 不是把多个存储伪装成事务：每个 owner 的动作必须可幂等恢复，回执含 exact lifecycle、请求绑定、清单摘要和参与者结果。插件只在所有者 `done` 后去掉相同条目；失败/待恢复条目不得继续提供普通 restore 来重开半删除的资源。

| 中断边界 | 候选恢复语义 |
| --- | --- |
| 插件 intent 已落盘，所有者无记录 | 保留条目，完成为需新计划的中断冲突；启动不新发删除。显式同身份重试也先查 owner，避免未知 acknowledgement。 |
| owner intent/fence 已落盘，但 quiescence 未确认 | 在宿主启动准入前恢复原操作并保留 fence；不从 SessionStore 空列表推断使用者已全部释放。 |
| 任意资源清除前后确认丢失 | 通过该 owner 的持久化子回执判断，不通过 `stat === undefined` 或路径缺失猜测整体成功；未确认范围继续为待恢复/部分失败。 |
| 日志已清除，Workspace/query/cache 未确认 | 保持 tombstone 和围栏；继续原操作收敛，条目显示待恢复，拒绝恢复或新生命周期进入旧操作。 |
| owner done，插件条目/回执未完成 | 仅补插件元数据；owner 历史回执不再清除资源，后来同名条目不受影响。 |

响应需区分 `rejected`、`conflict`、`pending-recovery`、`partial-failure` 和 `done`，并记录稳定 reason 与逐资源结果。连接丢失是客户端的未知观察，不改变 owner 已保存状态。取消仅在 owner admission 前或批量尚未开始的对象生效；durable fence 后卸载、断线或取消不能遗弃操作。无法证明恢复状态时保留围栏并报告人工介入条件，不解除保护后尝试普通恢复。

### 当前缺口与验证门槛

`0.2.0-rc.2` 未提供上述统一入口、持久化 lifecycle token、活动/归档联合准入围栏、逐目标 writer/read/observer 屏障、JSONL retirement lease/全代际清单、共享引用释放、Workspace 删除确认、派生数据持久化防复活或 owner 操作回执。AgentLoop 内部 composite teardown 有等待 idle 和 writer close 的顺序，但它不构成跨所有者的公开删除屏障。逐项源码依据见[资源所有者缺口表](research/permanent-deletion.md#resource-owner-contract-gaps)。这仍是公共 SDK 的缺口。用户明确选择由插件自行实现，当前版本绑定冷 JSONL Adapter 通过具体 writer inode lease、受控实例准入、精确文件清单和原生 metadata/query owner 收敛补齐声明范围；不扩展成所有 native/optional provider 的保证。生产 `prepare/execute` 使用 `unarchive`，旧 v1 只保守查询/恢复；v2 `preparePurge/executePurge` 及单项严格 Remote/UI 已接通，未支持、未审计或显式禁用组合返回可查询拒绝。固定批量与明确范围清空复用单项协议，选定编排见 [ADR 0009](decisions/0009-fixed-purge-batches.md)，正式行为见[客户端接口](client-interface.md#固定批量永久删除与清空)；各平台的实际验收及生产资格仍独立记录。

候选 owner 的临时数据验收必须覆盖：准备后生命周期/条目替换、native 活动切换和已准入工作、独立进程 writer 争用及稳定 lock inode、保留 reader/异步观察者、historical raw/zstd 全代际、未知/损坏资源、fork/子代理/spill/shared attachment 保留、晚到 cache/index 写回、每个 owner phase 的实际 SIGKILL 与重开、确认丢失、旧操作对新生命周期的拒绝，以及列表/搜索/Workspace/follow 的共同收敛。成功的准入缺口探针不替代这些删除与故障验收；只有 owner 实现通过独立验收后才将正式 Host 单项切片接到这一 seam。

## 能力验收边界

### 宿主兼容性

以锁定 SDK 和临时 DSH_HOME 检查原生 archive/unarchive、槽位、peer 与 Module Loader。产物必须能够真实加载，活动保护和恢复语义可复现；不具备的宿主能力有明确缺口，支持范围只包含有证据的版本与提供方。

### 可逆回收站

临时会话通过原生 Archive 进入管理集合；既有原生归档直接被计入，单项及固定选择的取消归档移除原生归档标记；失败和断线可查询、重试且不重复操作；并发与中断有明确结果；卸载无残留注册。原生浅深色、键盘与窄屏交互有实际验证证据。

### 永久删除准入

只为已验证的版本及提供方启用。临时会话上的检查须覆盖写锁、活动切换、中断、幽灵记录和缓存重建，再允许明确确认与批量操作。日志、索引与运行时列表在操作和重启后相符；不兼容版本或提供方不能执行；真实用户会话不用于破坏性测试。

### 分发准入

同一提交构建和验证预编译 npm tarball，安装/卸载、兼容性、许可与真实截图符合[分发与发布](release.md)的完成条件。市场收录由维护者评审，仓库年龄与功能重复规则是外部条件，不作为功能实现的保证。

## 后续能力

会话只读内容预览、按日期批量整理和状态筛选在基础功能可靠后加入。自动定期清空、AI 分类与跨设备同步不进入第一版；会增加恢复、调度或数据传输成本，尚无明确需求。
