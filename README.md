# DSH Session Bin

为 DeepSeek Harness 设计的会话回收站插件，关注原生交互、批量整理和可验证的会话生命周期。

**当前状态：已实现并验证首个 Host 回收站生命周期切片，包括移入、恢复、操作回执及中断后对账。尚无 Client 面板或 Remote 传输，不提供永久删除；开发包保留 `private: true`，未发布 npm 包或市场条目。** 接口与部署边界见[Host 生命周期](docs/host-lifecycle.md)，实际检查见[实现验证](docs/verification/host-lifecycle.md)。首轮 SDK 探针保存在本地 `spike/dsh-0.2-compatibility` 分支，结论见[兼容性验证](docs/verification/dsh-0.2-compatibility.md)。

## 阅读入口

- [设计提案](docs/design-proposal.md)：交互、Module 与 Interface、回收站所有权、兼容性限制和实施顺序。
- [当前 DSH 接口调研](docs/research/current-dsh-interfaces.md)：安装版本、活动保护、槽位和永久删除能力限制。
- [参考及分发调研](docs/research/reference-and-distribution.md)：参考项目代码、许可、npm 与 dsh-market 规则。
- [分发与发布](docs/release.md)：打包及验收流程。
- [贡献流程](CONTRIBUTING.md)：issue、分支、PR 和验证约定。
- [Agent 工作入口](AGENTS.md)：按任务加载上下文。

## 开发环境

工具版本集中在 [mise.toml](mise.toml)。Node 与 pnpm 对齐已安装 DSH 的发布元数据；GitHub CLI 固定到调研时可用版本。

在本地信任并安装该配置后，用 `mise run env` 查看工具版本。使用固定 pnpm 执行 `pnpm install --frozen-lockfile --ignore-scripts`，随后运行 `mise run verify`，依次完成严格类型检查、预编译构建、隔离生命周期测试和 tarball 的真实 Cordis Loader 验证。单项任务与使用时机见[Host 生命周期](docs/host-lifecycle.md)。实验分支仍提供 `mise run verify:compatibility`，复现范围见[兼容性验证](docs/verification/dsh-0.2-compatibility.md)。

仓库使用 `main` 作为默认本地分支。本地 `.local/` 包含调研时提取的安装包快照，并已从 Git 排除；事实和出处记录在研究文档，快照不作为发布依赖。

## 参考

- [Seetraum/harness-session-delete](https://github.com/Seetraum/harness-session-delete)：参考项目，调研时 npm 包名称为 `dsh-session-recycle-bin`。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主及官方插件接口。
- [dsh-market](https://github.com/dsh-market/dsh-market) 与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：市场与目录。

本实现采用 [MIT License](LICENSE)。参考项目提供了设计背景，本切片未复制其实现代码；今后复用上游代码仍需保留对应版权与许可。
