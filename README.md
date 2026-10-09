# DSH Session Bin

为 DeepSeek Harness 设计的原生归档管理插件，提供元数据搜索、工作区筛选、单项及固定选择的批量取消归档，并为已验证组合提供单项、固定批量永久删除与明确范围清空。

**当前状态：已切换到原生 Archive 为唯一入口，插件直接管理原生已归档集合，支持搜索、工作区筛选和单项/批量取消归档；已移除独立 Move to Session Bin 菜单与重复 Undo。旧 v1 条目和历史回执兼容处理，启动及迁移不改变原生归档状态。支持经源码指纹与资源准入检查的冷会话单项、固定选择批量永久删除及点击时全部原生归档的清空，提供原生确认界面、逐项结果与断线查询恢复。当前默认删除资格限 DSH `0.2.0-rc.2`、Node `24.18.1` / libuv `1.52.1`、macOS ARM64、单 Host，以及 JSONL raw/zstd、已知 Workspace/JSON domain 和已启用或明确禁用内存 SQLite 查询的已知组合；未验收组合明确拒绝。Windows、macOS Intel 和 Linux 的内核租约、文件身份及隔离候选验收已接入，生产资格不会因代码存在而自动扩大。共享附件 GC 未实现；开发包保留 `private: true`，未发布 npm 包或市场条目。** 接口与部署边界见[Host 生命周期](docs/host-lifecycle.md)和[客户端接口](docs/client-interface.md)，实际检查分别见[Host 验证](docs/verification/host-lifecycle.md)及[客户端验证](docs/verification/client-interface.md)。早期 SDK 探针的基线和复现方式见[兼容性验证](docs/verification/dsh-0.2-compatibility.md)。

## 首次公开发布目标

**原生归档管理重构已实现；当前仓库的构建产物使用这一模型。** 原生归档集合决定成员，插件观察元数据只绑定明确操作，不代表归档时间、原生代际或永久删除授权。 已选定语义及旧数据边界见[设计提案](docs/design-proposal.md#已选定的原生归档产品模型)。

首次公开发布以完成“原生归档 → 管理、取消归档或永久删除”的手动核心闭环为准入条件，包括单项永久删除、固定选择的批量永久删除及明确对象范围的清空回收站，并须支持 Windows、macOS、Linux 三类主要平台。永久删除只为独立验证通过的宿主版本、平台/架构、文件系统与存储提供方组合启用；三个平台均通过资源生命周期与故障验收后，再准备公开分发。日志预览、自动定期清空与跨设备同步不作为这一核心闭环的首发条件。功能范围与准入见[设计提案](docs/design-proposal.md)，跨平台分发条件见[分发与发布](docs/release.md)。

已实现严格 owner/lifecycle/资源清单合约、独立 sidecar、一次性 grant、逐资源回执与中断 guard，并接入本插件自行实现的版本绑定 `NativeRetirementOwner`。它使用完整已确认 JSONL 代际和 staging 清单，在稳定 `session.lock` inode 的排他租约内逐文件清除，收敛 Workspace、投影 cache 与 SQLite 自身索引；不递归删除目录、替换锁或直接写 SQLite 私有索引。原生 SDK 仍没有公共 delete 接口，插件的明确版本 Adapter 负责这些能力与准入，选定接入见 [ADR 0007](docs/decisions/0007-native-jsonl-deletion-adapter.md)。

删除仅接受已归档、无活动且无未排空读取/写入/迁移引用的冷会话；宿主仍加载的会话、子代理目标、未知/不可读文件、额外 hard link、无法证明原生 writer 排他租约或未审计组合都拒绝。删除对象只包含所选会话的日志及已声明会话元数据/索引；共享附件、工具中的外部副本和独立 fork 保留，不能当作全局附件清理或安全擦除。默认按已验证组合自动启用，可用 Host 配置 `permanentDeletion: false` 明确关闭。

版本绑定的平台 Adapter 已接入 POSIX flock、Windows 原生 writer 信号量、实际 FD 身份核验和同操作维护恢复；Windows cache 使用独占非 JSON stage，避免中断后生成 SDK 无法加载的空记录。生产资格与隔离 candidate 分开，决定见 [ADR 0008](docs/decisions/0008-cross-platform-retirement.md)，一手依据见[跨平台调研](docs/research/cross-platform-deletion.md)。浏览器将固定计划、授权见证与观察尝试保存在同一版本化记录，重载后继续核对已观察授权，缓存部分故障则保守保留未知结果。

显式准备仍绑定固定观察、Adapter 自有持久化 lifecycle nonce 与冻结清单，执行及 owner admission 再复核；观察、启动和迁移不补删除授权。新 v2 与旧 Bin v1 严格区分，旧 owner 资格不能自动用于新目标。新的确认、严格 Remote 和独立 pending 查询已接通；只查询不自动重发未知删除。原有 test-only owner 继续用于协议回归，其历史结果不代替本轮真实 erasure 验证。接口、支持限制与实际结果分别见[Host 生命周期](docs/host-lifecycle.md)和[Host 验证](docs/verification/host-lifecycle.md)。

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

在本地信任并安装该配置后，用 `mise run env` 查看工具版本。pnpm 使用 npm 分发后端，兼容缺少 standalone 安装包的 macOS Intel；mise 统一设置工作区缓存，脚本发现依赖漂移时明确报错，由 `mise run install` 使用 frozen lockfile、禁用安装脚本完成更新。`mise run verify` 执行两端类型检查、预编译构建、隔离行为与文案回归及 tarball 检查。`mise run verify:gui` 用系统 Chromium 顺序验收中文与 English 两个独立 Web profile，包含原生语言切换和安装/卸载；新 profile 使用缓存优先的在线安装补齐传递依赖，前提与范围见[客户端接口](docs/client-interface.md)。`mise run verify:platform` 在实际 OS 上通过隔离 composition 验收实现候选并保存源码基线；`mise run verify:linux` 用同版本 Node 容器在独立 Linux 文件系统运行该流程，需要 Docker。candidate 通过不自动扩大生产支持，Windows、macOS Intel 与 Linux 的实际验收矩阵和发布门槛见[分发与发布](docs/release.md)。实际结果和历史探针的复现方式见对应验证报告。

仓库使用 `main` 作为默认本地分支。本地 `.local/` 包含调研时提取的安装包快照，并已从 Git 排除；事实和出处记录在研究文档，快照不作为发布依赖。

## 参考

- [Seetraum/harness-session-delete](https://github.com/Seetraum/harness-session-delete)：参考项目，调研时 npm 包名称为 `dsh-session-recycle-bin`。
- [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager)：永久删除研究参考，包名称为 `@michengai/dsh-archive-manager`，采用 Apache-2.0；版本与证据见[永久删除调研](docs/research/permanent-deletion.md)。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：宿主及官方插件接口。
- [dsh-market](https://github.com/dsh-market/dsh-market) 与 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)：市场与目录。

本实现采用 [MIT License](LICENSE)。参考项目提供了设计背景，本切片未复制其实现代码；今后复用上游代码仍需保留对应版权与许可。
