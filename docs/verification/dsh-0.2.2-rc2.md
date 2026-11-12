# DSH 0.2.2-rc.2 适配与恢复验证

2026-11-12。插件目标版本为 `0.3.1`，精确 npm SDK 为 `0.2.2-rc.2`，上游提交为 `ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c`。固定 npm 和旧宿主拒绝目标见[共享目标配置](../../scripts/engineering/targets.json)。DSH `0.2.2-rc.1` 的发布与恢复证据属于插件 `0.3.0`。[上游发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2) · [rc.1 验证](dsh-0.2.2-rc1.md)

## 原始失败与源码审阅

- 五个巡检 SDK job 在类型检查失败，Desktop 候选在声明构建失败。以依赖草稿的 frozen lock 在本机复现。插件的 Zod `4.4.3` 与 rc.2 的 `dsh-storage-domain` 等 SDK 所用 `4.6.6` 导出类型不同。将插件依赖对齐为精确 `4.6.6` 后，声明和 bundle 构建通过。Cordis `4.1.0`、Loader `1.1.0` 和 Schemastery `3.19.0` 沿用。[巡检记录](https://github.com/takboo/dsh-session-bin/issues/28) · [依赖草稿](https://github.com/takboo/dsh-session-bin/pull/29)
- 比对 npm SDK 审计范围的 18 份文件，9 份字节变化。Workspace 新增归档后和取消归档前的宿主事件，API Session 变更子代理路由和 prompt 初始化，Session/Agent loop 增加批量事件发布。已审计的 JSONL、SQLite 持久化实现和投影 cache 文件字节一致。运行时仍精确核对宿主版本、参与包与摘要，旧 schema 1 durable fingerprint、冻结计划和回执身份沿用。
- 新增 `inspectSession` 经过独立的 query observation 路径。带已准备缓存的真实 Query 回归先复现围栏内 getter 仍运行，再确认围栏在 getter 前拒绝，sibling 可正常读取。元数据套件 49 项通过。[原始回归](../../.local/rc2-release/inspect-before.log) · [修复后回归](../../.local/rc2-release/metadata.log)

所有删除及恢复检查使用临时 `DSH_HOME` 与独立会话 fixture。永久删除以实际运行时、平台和存储提供方组合的独立证据为准。
