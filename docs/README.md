# 文档索引

本目录维护 `@takboo/dsh-session-bin` 的权威契约、工程工作流、架构决策、接口调研与分版本验证报告。项目总览见 [README](../README.md)，代理工作规则见 [AGENTS.md](../AGENTS.md)，源码布局见 [src/README.md](../src/README.md)，贡献规范见 [CONTRIBUTING.md](../CONTRIBUTING.md)。

## L1 权威文档与专题契约

| 文档 | 职责 |
| --- | --- |
| [开发与验证流程](workflow.md) | 统一 `mise` 任务、`check` / `verify:pack` / `verify:host` 门禁、E0–E4 证据分级与变更验证矩阵 |
| [Host 生命周期契约](host-lifecycle.md) | 原生归档集合、冷会话复核、永久删除准入矩阵、批量与恢复语义及并发部署边界 |
| [客户端接口契约](client-interface.md) | Web 客户端模块入口、Remote 契约、交互行为、中英文文案、主题与 GUI 检查要求 |
| [设计提案](design-proposal.md) | 已选定的原生归档产品模型与候选设计方案（候选设计不代表已实现能力） |
| [兼容性自动检查](compatibility.md) | 上游 DSH 新版发现、隔离候选验证、Desktop 载体补充验收与 Issue/草稿 PR 流程 |
| [分发与发布流程](release.md) | npm 包身份、GitHub Release 产物校验、`dshmarket` 目录规则与发布门禁 |

## 子目录导航

- [decisions/](decisions/)：已选定并影响后续实现的架构决策记录（ADR）。
- [research/](research/)：带宿主版本与一手源码出处的接口、分发及跨平台删除调研事实。
- [verification/](verification/)：按 DSH 版本、运行时平台及共享工程基座记录的实际验证基线、结果与限制。
- [images/](images/)：真实安装验收生成的浅色/深色界面与批量删除截图。

## 文档分层约定

- 事实与一手源码依据归 [research/](research/)，候选方案归 [设计提案](design-proposal.md)，已选定决策归 [decisions/](decisions/)，运行结果与限制归 [verification/](verification/)。
- 正式行为以专题契约为准，生产支持与永久删除资格以对应版本的运行证据为准；临时会话进度与交接不写入长期文档。
