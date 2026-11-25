# Agent 工作入口

[README](README.md) 是项目入口，[文档索引](docs/README.md) 与 [源码目录](src/README.md) 索引全仓结构，[开发与验证流程](docs/workflow.md) 定义统一任务与证据分级；正式行为以专题契约为准，支持资格以对应版本的运行证据为准。候选设计不代表已实现能力。

## 按任务阅读

- 工程与门禁：[开发与验证流程](docs/workflow.md)、[文档索引](docs/README.md)、[共享基座接入验证](docs/verification/shared-engineering.md)。
- 会话与存储：[Host 契约](docs/host-lifecycle.md)、[验证](docs/verification/host-lifecycle.md)、[原生归档决策](docs/design-proposal.md#已选定的原生归档产品模型)。
- 界面与 Remote：[客户端契约](docs/client-interface.md)、[验证](docs/verification/client-interface.md)。
- SDK 行为：[接口调研](docs/research/current-dsh-interfaces.md)、[兼容性验证](docs/verification/dsh-0.2-compatibility.md)，再核对目标版本的一手源码。
- 发布：[发布流程](docs/release.md)、[分发调研](docs/research/reference-and-distribution.md)，重新核对外部规则。Issue/PR 见[贡献流程](CONTRIBUTING.md)。

## 工作要求

- 继承 [dsh-engineering.lock.json](dsh-engineering.lock.json) 锁定基座（`v0.2.0`）`docs/engineering-contract.md` 的共享治理原则：**`Verification is all you need`**（`mise` 固定运行时、统一入口、E0–E4 诚实分级与同包 E1/E2 串联）、EGM 磁盘真相与产品 [README.md](README.md) 保护、YAGNI、变更须经独立只读复核后再提交，且未经明确授权不自动 push 或打 tag；业务内核、依赖与支持矩阵保持插件自治。
- 使用 [mise.toml](mise.toml) 的固定工具和任务，按 [开发与验证流程](docs/workflow.md) 的变更矩阵验证：常规检查通过 `mise run check`（含 `check:shell`），宿主容器 E2 验证通过 `mise run verify:host`；记录基线、结果与限制，同步契约及 README。界面使用原生控件和语义 token。
- 会话/存储检查使用临时 `DSH_HOME` 和独立 fixture；破坏性操作涉及真实会话时，必须有当前会话的明确授权。
- 正式构建使用声明的 SDK 和依赖；`.local/` 排除于 Git 与发布物。复用上游代码保留版权和许可。
- 事实归研究，候选归设计，已选定决策归 ADR，运行结果归验证报告；临时进度和交接留在会话或 Issue/PR。

## 必须保持的产品约束

- 原生 Archive 是唯一入口，插件管理原生已归档集合。旧 Bin core 仅用于历史日志/回执兼容及独立 owner 验证；启动、迁移和旧数据处理不得自动改变原生归档状态。
- 保留宿主原生归档活动检查。观察归档不构成删除授权；准备和执行复核固定对象、生命周期及资源清单。
- 永久删除只为独立验证通过的宿主、运行时、平台/架构、文件系统和存储提供方组合启用；candidate 验收不能自动扩大生产资格。
- 批量与清空保持固定对象范围、逐项结果和未知状态保护；重载或重连不得自动重发删除。
