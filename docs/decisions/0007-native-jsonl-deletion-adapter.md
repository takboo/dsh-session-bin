# ADR 0007：自行实现版本绑定的冷 JSONL 单项删除 Adapter

状态：已采用。适用范围为实际审计与测试的 DSH `0.2.0-rc.2`、Node `24.18.1`、macOS ARM64、单 Host；不声明 SDK 新增了公共 delete API。

## 背景

公开 SDK 没有完整永久删除入口。用户明确选择在插件内自行实现删除，而不是等待上游接口。[ADR 0006](0006-native-archive-retirement-binding.md)已经具备固定观察、exact lifecycle、冻结清单和一次性授权消费者；缺少的是实际资源 owner。

## 决定

实现 `NativeRetirementOwner`，组合 `NativeJsonlFiles`、原生 metadata Adapter 与既有 retirement 协调器。代码使用已审计包版本和源码指纹表准入；JSONL 具体实例、Workspace、cache、query 与历史控制器还须匹配已知结构及配置。非匹配版本、提供方、平台或被改动源码不启用删除。依赖明确声明为 SDK peer 与公开格式目录，不导入研究快照、私有未导出 codec，亦不修改安装的 Harness。

首个支持切片只接受原生已归档、无活动且没有未排空 live/Agent、reader/writer、query lease、follower 或迁移引用的冷会话。采用实例 guard，不改全局 prototype；保留原生 Archive 入口和行为。guard 覆盖原生可见性变更的执行队列、create/open/read/write、SessionStore 准入、cache 唯一写回入口及完整 query 请求。全局 header/historical-corpus 读帧排空后才能清除目标文件；其他会话的当前 writer 不因目标删除被停止。

Adapter 在明确 adoption 中生成自有持久化 lifecycle nonce，并绑定 store/root、目录、最低既存代际 anchor 与冻结 physical identities；它不是原生 header nonce。准备/执行/admission 复核固定观察及完整清单，同 SID 的已退役 namespace 不复用，旧回执不删除后来数据。观察、启动和迁移不生成新会话的删除授权。Namespace 和 journal 存入独立 `session_bin_jsonl_resources`、`session_bin_jsonl_retirement_owner` domain。

JSONL 仅清除已验证的具体 canonical V0–V4 raw/zstd 代际和有完整可识别 header 的两类 staging 文件。每行绑定路径布局、目录/文件 inode 与 birthtime、完整 bytes SHA-256；执行在已有空的 `session.lock` inode 排他权下逐次复核并 `unlink` 具体文件、fsync 父目录。保留目录和锁，不 `rm` 整目录，不用 writer open 触发迁移。额外 hard link、symlink、重复 SID 目录、未来代际、未知/不可读资源、缺少稳定锁等明确拒绝。目录祖先须可信且稳定；不声明抵抗恶意外部 namespace 替换或其他 Host/不受管理提供方。

metadata Adapter 定点清除冻结目标的 Workspace account、archive/pin 和 header 观察缓存，清除 projection cache 的真实 medium 文档并同步 memory；SQLite 通过自己公开 search 所触发的原生对账事务清目标派生行，不直接写 SQLite 私有索引。资源效果确认前不能产生 erased 回执；全部参与者收敛、生命周期 finalize 和 owner done 后才提交 Host 成功。共享附件、独立 fork、工具外部副本不在本次记录删除范围，不做共享 GC 或安全擦除声明。

维护权限为短寿命、可撤销 token，普通 domain/API 通知及 activity providers 不继承它。未知 I/O 暂停删除 owner/Module并保护相关目标；已知活动/争用返回业务拒绝。控制面观察、已接受 SDK读/写、文件动作和授权均被关闭 join。卸载后 pending/done 的窄目标 guard 保留；同 SDK 实例可信 namespace 接管须完成旧 owner drain、验证 durable store/root/fingerprint、撤销旧 callable aliases并同步安装新 guard；未 admission 的旧失败候选不得永久遮蔽正常会话。

严格 Remote/UI 开放单项 v2 删除：先准备固定对象，原生 Modal 默认取消焦点，明确不可逆语义及保留范围，勾选确认才执行同一计划。浏览器与 Host journal 共同恢复未知状态；自动恢复只查询，明确续办只使用已有固定操作，missing 必须重新准备与确认。批量永久删除和清空是后续独立切片。

## 影响

支持范围从纯消费者与 test-only owner 扩展为已验证组合的真实会话记录删除。早期公共 API 缺口研究仍成立，但不再决定插件必须永远拒绝自实现 Adapter。已有 v1/v2 兼容、单 Host、相同协调目录、未观察归档 ABA 和临时破坏性验证约束继续适用。

正式行为见[Host 生命周期](../host-lifecycle.md)，界面/传输见[客户端接口](../client-interface.md)，实际 erasure、SIGKILL 与支持证据见[Host 验证](../verification/host-lifecycle.md)及[客户端验证](../verification/client-interface.md)。
