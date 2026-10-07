# Agent 工作入口

当前仓库已实现 Host 生命周期、严格 Remote 和原生客户端切片，仍是私有开发包。[README](README.md)记录现状，[Host 生命周期](docs/host-lifecycle.md)与[客户端接口](docs/client-interface.md)记录正式行为和边界，[设计提案](docs/design-proposal.md)记录后续候选方案；提案不代表已完成能力。新的 session 先读[交接记录](docs/session-handoff.md)，核对主线和已通过的中英验证，再确定下一阶段任务。

## 按任务加载

- **实现或修改会话操作**：先读[设计提案](docs/design-proposal.md)、[当前 DSH 接口调研](docs/research/current-dsh-interfaces.md)、[兼容性验证](docs/verification/dsh-0.2-compatibility.md)、[Host 生命周期](docs/host-lifecycle.md)及[实现验证](docs/verification/host-lifecycle.md)，核对 archive、bin、purge 的语义及已复现的存储差异。
- **界面或插件挂载**：读[接口调研](docs/research/current-dsh-interfaces.md)的槽位与样式结论、[客户端接口](docs/client-interface.md)及[客户端验证](docs/verification/client-interface.md)，再核对对应版本 SDK；使用原生控件和语义 token。
- **打包、发布或市场提交**：读[分发与发布](docs/release.md)和[分发调研](docs/research/reference-and-distribution.md)，核对当前外部规则。
- **Issue、分支或 PR**：读[贡献流程](CONTRIBUTING.md)。

## 工作循环

1. 读取本轮任务相关文档，明确操作行为与可检查的完成条件。对不确定的宿主行为先查对应版本的一手源码。
2. 按 [mise.toml](mise.toml) 的版本在本地与 CI 使用相同工具。新增脚本时让配置成为命令的唯一来源，文档说明使用时机与原因。
3. 完成一个可验证的功能切片。会话操作从小的公共 Interface 验证；破坏性及故障注入测试使用临时 DSH_HOME 和测试会话。
4. 记录实际检查结果与限制。调整功能时同步对应专题文档，保持 README 中的实现状态和兼容性声明准确。

## 必须保持的约束

本插件回收站只包含本插件持久化条目指向的会话。原生归档活动检查保持有效；存储提供方与宿主能力经过验证后才启用永久删除。真实用户会话仅在当前会话有明确授权时用于破坏性操作。

本地 `.local/` 为研究快照，排除于 Git 和发布产物。正式构建使用声明的 SDK 与依赖。复用上游代码时保留版权和许可。

新增架构决定时只记录已经选定且影响后续工作的决定，连同依据；研究事实归研究文档，候选设计归设计提案，当前进度归 issue/PR 或工作记录。
