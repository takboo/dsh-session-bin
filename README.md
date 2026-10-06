# DSH Session Bin

为 DeepSeek Harness 设计的会话回收站插件，关注原生交互、批量整理和可验证的会话生命周期。

**当前状态：调研与设计阶段。工作区尚未实现可安装插件，也未发布 npm 包或市场条目。**

## 阅读入口

- [设计提案](docs/design-proposal.md)：交互、Module 与 Interface、回收站所有权、兼容性限制和实施顺序。
- [当前 DSH 接口调研](docs/research/current-dsh-interfaces.md)：安装版本、活动保护、槽位和永久删除能力限制。
- [参考及分发调研](docs/research/reference-and-distribution.md)：参考项目代码、许可、npm 与 dsh-market 规则。
- [分发与发布](docs/release.md)：打包及验收流程。
- [贡献流程](CONTRIBUTING.md)：issue、分支、PR 和验证约定。
- [Agent 工作入口](AGENTS.md)：按任务加载上下文。

## 开发环境

工具版本集中在 [mise.toml](mise.toml)。Node 与 pnpm 对齐已安装 DSH 的发布元数据；GitHub CLI 固定到调研时可用版本。

在本地信任并安装该配置后，用 `mise run env` 查看工具版本。当前只有工具配置和版本任务；构建、测试和打包任务会随实现加入。

仓库使用 `main` 作为默认本地分支。本地 `.local/` 包含调研时提取的安装包快照，并已从 Git 排除；事实和出处记录在研究文档，快照不作为发布依赖。

## 参考

- [Seetraum/harness-session-delete](https://github.com/Seetraum/harness-session-delete)：参考项目，调研时 npm 包名称为 `dsh-session-recycle-bin`。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主及官方插件接口。
- [dsh-market](https://github.com/dsh-market/dsh-market) 与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：市场与目录。

新项目许可建议采用 MIT；若复用参考项目代码，保留相应版权及许可。正式实现时加入完整 LICENSE 和需要的第三方说明。
