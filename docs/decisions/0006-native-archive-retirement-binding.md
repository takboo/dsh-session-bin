# ADR 0006：原生归档删除绑定与旧 Bin 授权严格区分

状态：已采用，Host 单项准备及授权消费者。本文记录绑定切片的历史边界；实际版本绑定冷 JSONL owner 和单项 Remote/UI 已由 [ADR 0007](0007-native-jsonl-deletion-adapter.md)补充，支持状态以 README 为准。

## 背景

[ADR 0005](0005-native-archive-collection.md)使原生 Archive 成为唯一入口。观察 UUID 只标识插件看到的集合对象，不是 native generation 或资源 lifecycle。[ADR 0003](0003-retirement-consumer.md)中的旧 Bin v1 见证在新移入时捕获，不能直接套在原生观察上。已有 owner 协调器的资源阶段、一次性 grant 与恢复 guard 可以复用，但新目标必须有独立的授权绑定和组合资格。

## 决定

原生 `preparePurge` 返回 v2 单项计划，固定观察 entryId，并只在显式准备时向独立获准 owner 获取 exact lifecycle、descriptor 与冻结清单。观察、列表、启动和迁移均不自动捕获见证。binding 带 `target: native-archive` 和 `entryVersion: 2`；owner request 保留原有 `bin` 字段名，但 v2 必须带 `kind: native-archive`。旧 v1 形状保持。

`session_bin_purge` storage domain version 仍为 1，严格 schema 兼容旧 v1 和明确的新 v2 record；不迁移旧数据或改变 native archive。plan、binding、entry、journal 和 owner request 的版本必须一致，已有 pending 也只由相应目标消费者恢复。operationId 跨协议统一认领，完成回执保持历史语义。

`ArchiveModule` 在自己的队列、未知故障暂停与 lease 下复用现有消费者。准备 inventory 等待后、执行及 owner admission 内复核固定对象、成员、活动、exact lifecycle、descriptor 和清单。同一观察的生命周期 binding 不替换；资源范围变化需要重新准备和确认，不扩大旧计划。

原生目标使用独立 composition 准入回调 `verifiedNativeArchive`；旧 Bin 的 `verified` 或 owner capability 自报不授予原生资格。联合归档/取消归档/置顶、create/resume、读写和可见性 admission 必须由实际 owner 提供并独立证明。默认 Service 不挂载 owner，不提供 Config 开关或删除 Remote/UI。

新旧 journal 共同施加 SID 动作 guard，只有本目标的 pending 才冻结其 exact 观察元数据。旧 pending 不隐藏新版原生成员。共享 journal 由 composition 在两个消费者排空后统一关闭；新旧显式恢复在同一已接受请求寿命内完成。owner done 先持久化，再只清理同一观察条目；普通查询不推进资源清除。

## 影响

原生归档无需旧 Bin 条目即可显式准备测试 owner 的删除计划；旧见证不会自动升级为新授权。可复用 owner 的闭世界测试只清除临时 domain 资源，其 scope 不协调真实 Workspace 变更，不能用作 native provider 准入。单 Host、相同协调目录、未知 I/O 重开和未观察归档 ABA 限制不变。

正式行为见[Host 生命周期](../host-lifecycle.md#原生归档单项删除准备与授权)，运行检查和支持限制见[Host 验证](../verification/host-lifecycle.md)。
