# ADR 0009：固定批次复用单项删除 journal

状态：已采用。范围为固定选择批量永久删除与“点击时全部原生归档”的清空。

## 背景

单项删除消费者已提供固定观察、exact lifecycle、冻结清单、一次性授权、逐资源回执及持久化故障恢复。批量要求逐项结果、停止未开始项、未知结果只查询，不要求跨会话原子提交。另建 Host batch journal 不会使多个资源 owner 原子化，却会增加重复恢复状态和三平台中断边界。

## 决定

1. 批次是 Client Model 的页面级编排，复用现有单项 Remote、Host consumer 与 owner。Host 不新增 batch journal；每项仍有自己的 operationId、原始计划和完整回执。
2. 点击时从完整当前原生归档集合冻结 `{sessionId, entryId}`。固定选择按 entryId 解析；清空明确为点击时全部已归档对象，搜索及工作区筛选不改变范围。准备过程中新归档或同 SID 的新观察不加入。
3. 首版串行逐项准备独立 lifecycle 与资源清单，全部准备结束后才确认。确认显示固定总数、可执行数、阻止数、逐项原因及资源保留范围；阻止项不伪造成 Host 执行回执。私有计划与公开快照分离，调用方改动不能扩展对象或清单。
4. destructive admission window 固定为 1。只有当前即将发送的一项进入持久化 pending；其余未发送计划仅在内存。终态 success/rejected/conflict 可继续，pending/partial/transport unknown/missing 都立即暂停后续项。
5. 停止只取消尚未开始的项，已接受准备须排空，已发送删除不 abort、不改 operationId、不释放 guard。当前未完成项由既有单项查询与同操作续办处理；未知结果结束后仍须显式继续剩余项。
6. 未观察 admission 的 missing 项必须重新准备并再次确认，不重发旧请求；已观察授权或无法恢复的观察见证仍保守保护。批次停止不能提供 discard、改绑或目录清理旁路。
7. 重载只查询已发送的单项 journal，未发送内存队列作废；不自动删除或恢复调度。未来若选定跨窗口批次共享或持久化聚合审计，再单独设计引用 child operationId 的外层 journal。
8. pending/grant/observation 缓存超限不静默截断。原文不迁移、不重写、不丢弃尾部保护；仅检查已有结果，禁止新删除。由于每批最多一个未终结发送项，超过 64 个终态目标也可串行完成而不耗尽这一窗口。

## 影响

清空不是全目录操作或动态扫描任务，也不扩大平台、存储提供方和共享资源资格。Windows、macOS、Linux 的原生文件与 metadata Adapter 继续负责实际资源效果；批量层不能绕过任何 owner 准入。单项及旧 v1 query-only 兼容不变。

正式行为见[客户端接口](../client-interface.md)，当前实现状态见 [README](../../README.md)，运行证据见[Host 验证](../verification/host-lifecycle.md)及[客户端验证](../verification/client-interface.md)。
