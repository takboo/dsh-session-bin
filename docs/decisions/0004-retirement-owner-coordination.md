# ADR 0004：资源 owner 通过逐参与者确认和维护 scope 推进 retirement

状态：已采用，可复用 owner 协调实现。本文不以协调器本身授予 native 资格；已实现的版本绑定 cold JSONL 接入由 [ADR 0007](0007-native-jsonl-deletion-adapter.md)独立决定和验证。

## 背景

[ADR 0003](0003-retirement-consumer.md)确定了 Host 消费者的条目授权与恢复 guard。测试参考 owner 已证明消费者协议，但把阶段推进留在测试 helper 中无法约束后续资源参与者的屏障、回执和重启顺序。公开 SDK 的资源所有者缺口仍见[研究](../research/permanent-deletion.md#resource-owner-contract-gaps)。

持久化 quiescence 只证明此前确认过排空，不能代替新进程中的 writer lease。资源效果与确认落盘之间也有中断窗口；单次清理或一般路径缺失不能作为所有资源完成证书。

## 决定

将阶段推进提炼为 `RetirementOwnerCoordinator`，生命周期 port 和资源 participant 只提供它们实际拥有的资源操作。默认 Service 不挂载该 owner，不凭能力自报启用 native 删除。测试 helper 仅保留端口适配和独立测试数据，不自行生成 phase。

使用独立 `session_bin_retirement_owner` v1 domain，单条记录原子保存 public state、逐参与者 fence/quiesce/converge 确认、生命周期排空/完成确认与阻止原因。descriptor、参与者集合和版本绑定后不可切换；已保存的请求、grant、清单摘要、成功资源回执和确认阶段不能倒退。

所有参与者，包括没有资源行的参与者，必须确认 fence 和排空。之后按冻结清单推进引用释放、独占资源清除与共享/协调保留，再确认全部参与者收敛及生命周期 finalize，才能提交 done。barrier 返回 false 表示已知 pending；资源 failed 回执保持 erasing，只有显式恢复重试。抛出的未知异常立即暂停所有 owner 路由，不能继续写确认或执行下一个资源动作。

初始化只校验 journal、绑定 guard 后开放请求，不自动清除资源。guard 检查完整初始化、关闭和未知故障状态，不能只读可能落后于 medium 的内存 journal。进行中的 admitted 操作阻止同 SID 新代际；done 对 exact 旧 token 保留 tombstone，新的 token 可以创建；拒绝与冲突不永久封住 SID。

恢复只使用已保存 operation 的维护 scope。在日志已消失或 finalize 已作用但确认未落盘时仍能收敛，不能通过普通 create/resume 重建旧 Session。每次恢复须重新建立当前 runtime 排他权和租约，不能以旧确认省略实际资源协调。资源动作和所有屏障按同一 operation/lifecycle/resource/revision 幂等。

Host 向 retire 传完整冻结清单的独立快照作为可选第三参，保留二参 owner 兼容；新协调器对新操作要求它。范围变化的拒绝回执使用原清单，不以新清单改写授权。排空后若出现已准入写入或新代际，保留原 quiesced guard 与明确阻止原因，不自动扩大范围。

每个端口等待前后复核故障和参与者版本，每个持久化确认后检查工作预算。独立 inspect 不重入维护队列，但关闭会等待它；已入队维护使用私有异步上下文完成授权观察，外部普通路由仍拒绝 closing。scope/disposer 先接管再做 await 后健康检查，未知故障先暂停再执行 cleanup，避免释放窗口及 ownership 泄漏。

## 影响

新机制约束 owner 的进度和恢复顺序，但资源归属、实际写入者和读取引用排空、共享引用真实性仍必须由各资源所有者提供并独立验证。当前 SDK 缺少这些完整公开能力，native 支持范围保持不变。

未知结果需要完整重开；清单在排空后漂移可能要求资源所有者维护处理，不能用普通恢复或新 operationId 绕过 guard。回执和旧生命周期 tombstone 不自动裁剪。单 Host、共享 backend 的相同协调目录与未观察归档 ABA 限制继续适用。

正式端口和阶段规则见[Host 生命周期](../host-lifecycle.md#可复用资源-owner-协调)，实际构建、故障和进程终止结果见[Host 验证](../verification/host-lifecycle.md)。
