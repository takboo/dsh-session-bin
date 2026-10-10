# DSH Session Bin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的原生归档管理插件。在一个面板中搜索、筛选和管理已归档会话，支持取消归档、单项永久删除、批量永久删除和清空归档。

插件直接管理 Harness 的原生 Archive 集合，已有归档也会显示。归档仍使用宿主的原生操作。

## 功能

- 默认按工作区分组；按会话名称及工作区元数据搜索、筛选。
- 单项或批量取消归档，让会话回到原生会话列表。
- 单项永久删除、固定选择的批量永久删除，以及清空点击时的全部归档。
- 简洁的删除确认，可在设置中全局关闭；批量操作显示进度和日志，完成后保留简短统计及失败项。中断或断线后可查询结果并明确继续。
- 中英文界面，使用宿主控件、浅色和深色主题。

当前版本为 `0.2.0`，包名为 `@takboo/dsh-session-bin`。GitHub Release 提供预编译 tarball；npm 通过 trusted publishing 自动发布同一份产物。[dshmarket 收录流程](docs/release.md#dshmarket)独立于 npm 发布，须经目录检查与维护者审核。核心功能已完成跨平台验收；运行证据见 [Host 验证](docs/verification/host-lifecycle.md#跨平台生产删除资格晋级验证)和[客户端验证](docs/verification/client-interface.md#跨平台生产删除客户端验证)。

## 界面预览

![原生归档管理与批量选择](https://raw.githubusercontent.com/takboo/dsh-session-bin/v0.2.0/docs/images/archives-light.png)

[深色界面](docs/images/archives-dark.png) · [批量永久删除确认](docs/images/batch-deletion.png)。截图来自 `0.2.0` 的真实安装验收，使用隔离测试会话。

## 兼容性

永久删除绑定 DSH `0.2.0-rc.2`、Node `24.18.1` / libuv `1.52.1`，使用单 Host 和已验证的 JSONL raw/zstd 存储组合。

| 已验收环境 | CPU 架构 | 文件系统 |
| --- | --- | --- |
| Windows Server 2025 | x64 | NTFS |
| macOS 15 | Apple Silicon ARM64、Intel x64 | APFS |
| Ubuntu 24.04 | ARM64、x64 | ext2/ext3/ext4 family（type `0xef53`） |

表格记录实际验收环境，不代表所有 Windows、macOS 或 Linux 版本均已验证。Windows ARM64、其他运行时及未验证的存储组合不在支持范围内。永久删除还会检查宿主源码、资源身份和当前状态；不满足条件时明确拒绝。完整准入与限制见 [Host 生命周期](docs/host-lifecycle.md)。

## 安装

从 npm 安装已发布的预编译包：

```sh
dsh plugin --profile web add @takboo/dsh-session-bin@0.2.0
```

以上命令使用已安装的 DSH `0.2.0-rc.2`，将完整插件 bundle 安装到 `web` profile。桌面版请在其对应 profile 的插件管理页面安装同一个 npm 包。启动或重新启动该 profile 后，从侧栏打开“会话回收站”（Session Bin）。发布包包含预编译 Host 和 Client，使用者安装时无需编译 TypeScript；其 tarball 已通过真实 CLI/GUI 验证。

卸载同一 profile 中的插件：

```sh
dsh plugin --profile web remove @takboo/dsh-session-bin
```

也可下载 [v0.2.0 Release](https://github.com/takboo/dsh-session-bin/releases/tag/v0.2.0) 中的三个附件，核对 `SHA256SUMS` 后运行 `dsh plugin --profile web add ./dsh-session-bin.tgz`。自行构建时，先完成下方[开发入门](#开发入门)，再运行 `mise exec -- pnpm exec npm pack --ignore-scripts`。

如安装过早期未加 scope 的开发包，先从同一 profile 卸载 `dsh-session-bin`，再安装 scoped 包，避免重复注册；原生归档和已有操作记录保留。分发契约见[发布文档](docs/release.md)。

### 自动构建与 Release

每次分支 push 或 PR 的 Linux x64 验收通过后，[GitHub Actions](https://github.com/takboo/dsh-session-bin/actions/workflows/host-lifecycle.yml) 提供 `release-payload` artifact，包含真实测试过的 tarball、校验文件和提交信息，供发布前检查。

推送与 `package.json.version` 一致的 `v<version>` tag 时，五个平台全部通过后自动创建 [GitHub Release](https://github.com/takboo/dsh-session-bin/releases)，附上 `dsh-session-bin.tgz`、`SHA256SUMS` 和 `release.json`。预发布版本标记为 prerelease；tag 须指向 `main` 历史中的提交。版本 tag 的推送就是发布触发操作，流程见[发布文档](docs/release.md#自动-tarball-release)。

## 使用

1. 使用 Harness 原生“归档会话”操作归档目标会话。
2. 打开“会话回收站”，搜索或筛选已有归档；选择单项或多项取消归档。
3. 永久删除时，核对确认窗口中的对象和阻止原因，再确认执行。设置中的“永久删除会话前进行确认”默认开启；关闭后，点击单项删除、删除所选或清空将直接开始永久删除。
4. 批量操作期间查看进度和日志，完成后只保留统计及需要处理的项。如出现部分失败或连接中断，先检查操作状态，再决定是否继续。

**“清空全部归档”包含点击时的全部归档，搜索和工作区筛选不会缩小其范围。** 批量删除固定开始时的对象，后来新增的归档不会加入。

永久删除不可撤销，仅允许已归档、无活动且无未释放读写引用的冷会话；删除准备会释放由 API Session 激活且确认空闲的目标 Agent，再复核冷会话条件；活动任务、其他所有者的 Agent 和未释放的读写引用仍会阻止删除。清除范围是目标会话日志及已声明的会话元数据、索引；共享附件、外部副本和独立 fork 会保留。插件不提供共享附件垃圾回收或安全擦除保证，也不支持自动定期清空、跨设备同步或多 Host 协调。可通过 Host 配置 `permanentDeletion: false` 关闭永久删除，配置说明见 [Host 生命周期](docs/host-lifecycle.md)。

## 开发入门

使用 [mise](https://mise.jdx.dev/) 管理工具版本，固定配置在 [mise.toml](mise.toml)。

```sh
git clone https://github.com/takboo/dsh-session-bin.git
cd dsh-session-bin
mise trust
mise install
mise run install
mise run verify
```

`mise run install` 按 frozen lockfile 安装依赖并禁用安装脚本。`mise run verify` 完成类型检查、构建、隔离行为测试和真实 tarball 加载检查；测试使用临时 `DSH_HOME` 与测试会话。

| 命令 | 用途 |
| --- | --- |
| `mise run env` | 查看固定工具版本 |
| `mise run check` | 检查 Host 与 Client 类型 |
| `mise run build` | 生成预编译产物和类型声明 |
| `mise run verify` | 完整本地行为与打包验证 |
| `mise run verify:gui` | 隔离 Web profile 中的双语 CLI/GUI 验证 |
| `mise run verify:platform` | 记录实际操作系统的候选组合验收证据 |
| `mise run verify:linux` | 在固定 Node 的 Linux 容器内验证，需要 Docker |

GUI 验证需要可用 Chromium 和 npm registry 网络访问，准备方式见[客户端接口](docs/client-interface.md#构建和检查)。候选验收通过不会自动扩大生产支持矩阵。本地 `.local/` 存放研究快照及测试证据，不进入 Git 或发布包。

## 文档与贡献

欢迎通过 [Issues](https://github.com/takboo/dsh-session-bin/issues) 报告问题或提出功能建议。兼容性问题请提供 DSH/Node 版本、操作系统、架构、文件系统和存储提供方；样本使用测试数据。开发和 PR 约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，代理工作入口见 [AGENTS.md](AGENTS.md)。

- [Host 生命周期](docs/host-lifecycle.md)、[客户端接口](docs/client-interface.md)：正式行为、配置及部署边界。
- [Host 验证](docs/verification/host-lifecycle.md)、[客户端验证](docs/verification/client-interface.md)：分版本的实际检查结果。
- [设计提案](docs/design-proposal.md)、[架构决定](docs/decisions/)：产品模型、候选设计与已选定决策。
- [当前 DSH 接口调研](docs/research/current-dsh-interfaces.md)、[兼容性验证](docs/verification/dsh-0.2-compatibility.md)：SDK 依据与早期探针。
- [分发与发布](docs/release.md)：npm、GitHub Release 和市场提交流程。

## 许可与参考

本项目采用 [MIT License](LICENSE)，版权归 DSH Session Bin contributors。

以下项目为接口、产品设计和兼容性研究提供了参考；本项目未复制这些参考插件的实现代码，也不代表其维护者或 DeepSeek 官方背书。

| 项目 | 参考内容 | 上游许可 |
| --- | --- | --- |
| [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) | 宿主及官方插件接口 | 以上游仓库和各依赖包声明为准 |
| [Seetraum/harness-session-delete](https://github.com/Seetraum/harness-session-delete)（`dsh-session-recycle-bin`） | 归档管理交互及分发方式 | MIT，Copyright 2026 Seetraum |
| [MichengAI/dsh-archive-manager](https://github.com/MichengAI/dsh-archive-manager) | 永久删除与兼容性研究 | Apache-2.0 |
| [dsh-market](https://github.com/dsh-market/dsh-market)、[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 插件市场与目录规则 | 以上游仓库声明为准 |

版本、源码出处与研究结论见[参考及分发调研](docs/research/reference-and-distribution.md)和[永久删除调研](docs/research/permanent-deletion.md)。项目的 MIT 许可不替代第三方依赖的许可；复用上游代码时须保留适用版权、许可及通知。
