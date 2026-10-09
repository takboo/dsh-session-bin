# ADR 0003：Host 删除消费者使用独立 sidecar 与一次性 owner 授权

状态：已采用，Host 单项协议消费者。目标 SDK：DSH `0.2.0-rc.2`；没有原生永久删除 provider 准入。本文的 v1 Bin 移入捕获规则保留用于旧日志及测试；原生归档显式准备、v2 绑定和独立准入由 [ADR 0006](0006-native-archive-retirement-binding.md)补充。

## 背景

[资源研究](../research/permanent-deletion.md)和[准入验证](../verification/host-lifecycle.md#永久删除资源准入探针)确认公开 persistence 不提供完整 retirement，flush、detach、列表缺失或诊断路径都不是清除授权。删除需要 owner 自己承担生命周期、资源归属、活动/写入者围栏、共享保留与重启收敛。

现有 `session_bin` v1 和严格 Remote 已有可逆归档/恢复的历史数据及调用方。公开 storage-domain 不执行 domain 数据迁移；直接提高 version 或在原 action enum 加 purge 会同时破坏旧数据或扩大 wire 能力。删除与恢复也不能各有独立队列或重复取得 lifetime lease。

## 决定

保留归档 domain 与 v1 DTO，新建 `session_bin_purge` v1 sidecar。它保存按 immutable entryId 绑定的 lifecycle/owner 见证及独立删除 journal；只在新移入时捕获获准 owner 的见证，prepare purge 不按旧 Session ID 补授权。两个 journal 共用原 Host Module 的队列、未知故障暂停和 lifetime lease，operationId 在动作间统一认领。

Host 只实现经过严格校验的 owner 协议消费者，不自行解析或删除 native 会话文件。默认 Service 没有获准 owner，Config 或能力自报不能启用删除。本文默认无 owner 的阶段描述为消费者切片历史；实际冷 JSONL owner、准入和 Remote/UI 由 [ADR 0007](0007-native-jsonl-deletion-adapter.md)补充。构造器 seam 供已验证的 Host composition 使用；当前执行资源清除的参考 owner 仅在 tests 下，独立拥有临时 domain，不作为 JSONL/native 支持依据。

计划绑定 exact entry、持久化 lifecycle、owner/参与者版本和冻结资源清单摘要；执行重新检查，资源 owner 的围栏内再调用 Host 本地授权 callback。清单及 done 回执必须逐资源闭合，保留的共享/协调资源须有明确依据，任何失败、缺失或未知结果都不能变成成功。

授权能力只使用一次，owner 调用结束后撤销新调用并排空已开始 callback。Host 先保存 `authorizing` 尝试与随机 nonce，最终核对通过才把 nonce 作为 grant 返回 owner；请求不含 nonce。只有匹配同一 grant、请求及清单的 owner admission 回执才可恢复，不能从一个尝试 stamp 推断 callback 成功。

Host 观察到 owner admission 后先持久化回执，再推进 owner 恢复。完整 done 回执也先落盘，再清除仍匹配的插件 entry，最后保存 Host done；旧回执始终保持历史语义。同一未完成删除的 journal 构成持久化 guard，普通恢复与归属清理不提前移除它。只有同一可信 owner 明确表示未 admission，才能以中断冲突释放 guard；owner 缺席、错误或状态回退均保留保护。

普通准备、列表及归档帧不推进 owner 资源清除。启动和显式恢复仅继续同一已持久化 owner 操作，不从插件 intent 重新发起删除。未知 owner、sidecar 或提交 I/O 一律暂停 Module，不因外部错误被包装为业务错误类而继续写入。

## 影响

旧条目、归档回执和 Remote 调用保持兼容；新增接口只在 Host 暴露。实际原生删除仍依赖资源 owner 的公开能力与独立验收，消费者和参考 owner 验证不能扩大支持范围。共享 Bin backend 仍需同一协调目录，单 Host 原生 Workspace 和未观察归档 ABA 的限制继续遵循 [ADR 0001](0001-host-lifecycle.md)。

卸载等待初始化、队列和 callback 排空，再分别关闭所有 domain 并释放 lease。关闭 acknowledgement 失败会聚合报告；公开 Domain 已拒绝新写入，但故障 Context 不能继续复用，应完整重开后对账。

正式接口与恢复规则见[Host 生命周期](../host-lifecycle.md#host-单项删除协议消费者)，实际验证、代码基线和限制见[Host 验证](../verification/host-lifecycle.md)。资源 owner 的完整协议及未来 provider 准入仍保留在[设计提案](../design-proposal.md#永久删除资源生命周期候选协议)。
