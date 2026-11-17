# DSH 0.2.2-rc.3 适配与恢复验证

Session Bin `0.3.2` 锁定 DSH `0.2.2-rc.3`，上游提交 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`。升级基线为已发布的 Session Bin `0.3.1` / DSH `0.2.2-rc.2`。所有删除和恢复操作使用临时 `DSH_HOME` 与独立会话。 [上游发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3) · [适配 PR](https://github.com/takboo/dsh-session-bin/pull/32) · [rc.2 验证](dsh-0.2.2-rc2.md)

## 源码与准入

- npm 与官方 macOS ARM64 Desktop ASAR 的 18 份删除链路审计文件均与 rc.2 字节一致，覆盖 Cordis、Session/Agent、JSONL、Workspace、SQLite 查询及投影缓存。上游客户端增加新会话操作槽和工作区选择器工厂，Session Bin 继续通过原面板槽位挂载。 [上游源码对比](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.2...dsh-v0.2.2-rc.3) · [候选巡检](https://github.com/takboo/dsh-session-bin/actions/runs/43403035642)
- 正式准入核对 rc.3 的宿主、SDK 文件 SHA-256 和 JSONL 私有类身份。schema 1 的资源 fingerprint、冻结清单和回执身份沿用 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md)。运行时、平台、文件系统和存储范围见 [Host 契约](../host-lifecycle.md#真实冷-jsonl-单项删除-adapter)。
