# DSH Session Bin

为 DeepSeek Harness 设计的会话回收站插件，关注原生交互、批量整理和可验证的会话生命周期。

**当前状态：已实现可恢复的 Host 生命周期、严格 Remote 传输和原生客户端切片，包括会话菜单、撤销、回收站面板、元数据搜索、工作区筛选与批量恢复。不提供永久删除；开发包保留 `private: true`，未发布 npm 包或市场条目。** 接口与部署边界见[Host 生命周期](docs/host-lifecycle.md)和[客户端接口](docs/client-interface.md)，实际检查分别见[Host 验证](docs/verification/host-lifecycle.md)及[客户端验证](docs/verification/client-interface.md)。早期 SDK 探针的基线和复现方式见[兼容性验证](docs/verification/dsh-0.2-compatibility.md)。

## 首次公开发布目标

**产品方向已调整：以 Harness 原生 Archive 为唯一入口，插件直接管理原生已归档会话，移除自建 Move to Session Bin 与平行目录。此重构尚未实现；当前安装包仍是上面的 Bin 模式。** 已选定语义及旧数据边界见[设计提案](docs/design-proposal.md#已选定的原生归档产品模型)。

首次公开发布以完成“原生归档 → 管理、取消归档或永久删除”的手动核心闭环为准入条件，包括单项永久删除、固定选择的批量永久删除及明确对象范围的清空回收站。永久删除只为独立验证通过的宿主版本与存储提供方启用；通过资源生命周期与故障验收后，再准备公开分发。日志预览、自动定期清空、其他平台与跨设备同步不作为这一核心闭环的首发条件。功能范围与准入见[设计提案](docs/design-proposal.md)，分发条件见[分发与发布](docs/release.md)。

资源生命周期准入已有 12 项临时数据探针，验证了公开 SDK 的 writer、disposal、身份、代际、不可读记录与共享附件边界。已实现 Host 单项删除协议消费者：严格 owner/lifecycle/资源清单合约、独立 sidecar、一次性授权 grant、逐资源回执与中断恢复 guard；并提供可复用 owner 协调器，原子记录各资源参与者的围栏、排空、收敛与生命周期完成确认，参考 owner 已改为端口适配。接口及行为见[Host 生命周期](docs/host-lifecycle.md#host-单项删除协议消费者)。默认 SDK 组合没有获准的资源 owner，仍拒绝原生永久删除，Remote/UI 也未开放删除。测试参考 owner 独立拥有临时 domain 资源，其结果不扩大原生删除支持；证据范围见[Host 验证](docs/verification/host-lifecycle.md)。

## 阅读入口

- [客户端接口](docs/client-interface.md)：原生面板、严格 Remote、连接恢复、槽位和构建生命周期。
- [客户端验证](docs/verification/client-interface.md)：真实插件与实际 CLI/浏览器的分层证据。
- [设计提案](docs/design-proposal.md)：交互、Module 与 Interface、回收站所有权、兼容性限制和实施顺序。
- [当前 DSH 接口调研](docs/research/current-dsh-interfaces.md)：安装版本、活动保护、槽位和永久删除能力限制。
- [永久删除调研](docs/research/permanent-deletion.md)：锁定 SDK 的资源生命周期、已发布参考实现及尚缺的验证证据。
- [参考及分发调研](docs/research/reference-and-distribution.md)：参考项目代码、许可、npm 与 dsh-market 规则。
- [分发与发布](docs/release.md)：打包及验收流程。
- [贡献流程](CONTRIBUTING.md)：issue、分支、PR 和验证约定。
- [Agent 工作入口](AGENTS.md)：按任务加载上下文。

## 开发环境

工具版本集中在 [mise.toml](mise.toml)。Node 与 pnpm 对齐已安装 DSH 的发布元数据；GitHub CLI 固定到调研时可用版本。

在本地信任并安装该配置后，用 `mise run env` 查看工具版本。`mise run install` 使用 frozen lockfile、禁用安装脚本并填充项目离线缓存；`mise run verify` 执行两端类型检查、预编译构建、隔离行为与文案回归及 tarball 检查。`mise run verify:gui` 用系统 Chromium 顺序验收中文与 English 两个独立 Web profile，包含原生语言切换和安装/卸载，前提与范围见[客户端接口](docs/client-interface.md)。实际结果和历史探针的复现方式见对应验证报告。

仓库使用 `main` 作为默认本地分支。本地 `.local/` 包含调研时提取的安装包快照，并已从 Git 排除；事实和出处记录在研究文档，快照不作为发布依赖。

## 参考

- [Seetraum/harness-session-delete](https://github.com/Seetraum/harness-session-delete)：参考项目，调研时 npm 包名称为 `dsh-session-recycle-bin`。
- [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager)：永久删除研究参考，包名称为 `@michengai/dsh-archive-manager`，采用 Apache-2.0；版本与证据见[永久删除调研](docs/research/permanent-deletion.md)。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主及官方插件接口。
- [dsh-market](https://github.com/dsh-market/dsh-market) 与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：市场与目录。

本实现采用 [MIT License](LICENSE)。参考项目提供了设计背景，本切片未复制其实现代码；今后复用上游代码仍需保留对应版权与许可。
