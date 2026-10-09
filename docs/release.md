# 分发与发布

本文记录分发契约、发布流程和验收条件；实现及发布状态见 [README](../README.md)。依据为[分发调研](research/reference-and-distribution.md)及[市场贡献规则](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)，规则核对日期 2026-10-06。外部规则可能变化，实际发布前重新核对。

## 一个包、同一份产物

Host 与 Client 放在一个预编译 npm 包中；Host 使用 ESM，Client 使用 DSH Module Loader 的 lazy CommonJS factory 格式，并声明明确的 exports 和 files 白名单。发布物包含 Host 入口、DSH Module Loader 格式的 Client 入口、样式资源、bundle patch、README 与 LICENSE；项目文档按用户需要选取。排除本地源码快照、开发数据、测试会话及凭据。

`dsh.bundle.patch` 指向随包发布的 [cordis.patch.yml](../cordis.patch.yml)。Host ESM、Client lazy factory 和共享 `./remote` 合约有明确导出；浏览器入口声明 `dsh.client.platform = web` 与 `exports["./client"]`。patch 只挂载本插件 Host 行，不替换宿主归档实现；不能仅以 `dsh.client` 代替 bundle 安装元数据。实际 CLI 和客户端检查范围见[客户端验证](verification/client-interface.md)。

官方宿主运行时包使用 peerDependencies，开发编译所需 SDK 固定版本放入 devDependencies。SDK 按有运行证据的兼容范围锁定，具体版本见[验证报告](verification/client-interface.md)；扩展范围时显式考虑 semver 对预发布版本的匹配。React、Cordis 和共享控件的运行时身份遵守宿主 Module Loader 外部模块契约，并通过真实 tarball 加载确认。

原生插件管理页面的名称和描述通过导出的 `locale/en.json` 及语言资源中的 `meta.title`、`meta.description` 提供，同时导出 `./package.json` 并打包顶层 `icon` 指向的图标。当前版本该读取路径不使用参考项目的 `dsh.displayName` 等自定义字段；本项目使用已核对的原生元数据契约。

npm `repository` 指回最终 GitHub 仓库，`homepage`、`bugs`、`keywords` 和 DSH 元数据保持一致。暂定名称 `dsh-session-bin`，发布前核对占用情况。源码或构建产物复用参考项目时保留 MIT 版权。

## 环境与 CI

工具版本由 [mise.toml](../mise.toml) 管理。CI 使用同一配置和 frozen lockfile，任务由 [package.json](../package.json) 的 scripts 提供。工具安装和项目依赖锁定分别由 mise 与 pnpm 负责，避免并行维护另一套版本文件。

发布验收包含以下检查：

1. 类型与静态检查；影响相应操作的行为测试。
2. 临时 DSH_HOME 上的真实宿主加载与生命周期验证。
3. Client 对原生浅色、深色、键盘和窄屏的实际验证。
4. 预编译打包，核对 exports、bundle patch、文件白名单、包内资源与许可。
5. 在干净 fixture 中用 tarball 安装并卸载，确认用户安装不依赖全局 TypeScript 或安装时构建。

永久删除至少验证日志与索引一致性、运行时重新加载、写锁竞争、活动出现、重复请求、中途失败和重启对账。未支持的存储提供方有明确结果。CI 中不使用真实用户会话目录。

`mise run verify:platform` 使用当前实际 OS 的隔离候选 composition，执行类型、构建、全部行为回归及 tarball 检查，并保存源码 SHA-256 和运行平台；候选资格不会自动写入生产支持矩阵。`mise run verify:linux` 从 manifest 的 Node 版本选择容器镜像，复制项目源码到独立 Linux 文件系统运行同一验收，报告和临时证据导出到工作区。Docker/WSL/模拟 CPU 的结果必须写明环境，不作为实际 Windows 桌面验收。

[CI 矩阵](../.github/workflows/host-lifecycle.yml)声明 Windows x64、macOS ARM64/Intel、Linux ARM64/x64 runners，启动时核对实际平台与架构。干净 runner 先显式运行 `mise run verify:gui:browser` 准备锁定 Playwright Chromium 和系统依赖，浏览器缓存位于工作区；再运行双语真实 CLI/GUI 并保留报告与截图。未获生产资格的平台的 GUI 拒绝检查须标记 unsupported，不能写成成功删除，更不能满足发布所要求的实际删除验收。Windows GUI 测试通过隔离 Node IPC 投递给 SDK 原有关闭处理器，单独记录这一关闭方式，不把它写作 POSIX OS 信号。

项目 frozen lockfile 安装只填充该依赖图的缓存，新 profile 独立解析的传递版本可能不同；不能据此承诺干净 profile 已具备全部离线依赖。新 profile 验证使用 `--prefer-offline` 并允许补齐依赖。较早 dev.2 Linux 卸载未自然退出的[失败补验](verification/host-lifecycle.md#linux-cli-补验与未通过边界)保留原有基线；pnpm `11.23.0` 修复工作线程退出问题后的 Linux x64 全量及双语 CLI/GUI 已通过，见[复验](verification/host-lifecycle.md#跨平台-ci-与-pnpm-退出修复验证)。每个支持组合仍须独立证明安装、卸载并正常退出；`Done` 输出、强制终止和源码平台候选矩阵都不能代替通过，CLI/GUI 通过也不自动扩大生产删除资格。

## npm 与 GitHub Release

从通过检查的同一提交生成一次 tarball。npm 发布该 tarball；GitHub Release 附相同产物及校验摘要，并说明 DSH 支持范围、变化和已知限制。发布渠道的版本与 git tag 一致。

优先选择 [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)；具体启用条件与账户配置在包身份确定后核对。发布前准备可审阅的版本、产物及 release 内容，使用项目授权身份并遵守仓库发布规则。

## dsh-market

市场使用 [awesome-dsh-plugin 目录](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)。目录条目位于 `data/plugins/<owner>__<repo>.yml`，匹配实际仓库与已实现能力；会话整理插件使用相应的 `session` 分类。

收录需真实可用代码、`dsh.bundle`、仓库创建满一天、活跃维护，以及 `dsh-plugin` topic。已有参考项目被收录，维护者会评估功能重叠；新项目必须展示实际新增行为或维护改善，原生外观本身不保证通过。

npm 包的 `repository` 与目录仓库匹配时，由市场自动关联。条目不添加 `npm:` 字段，不通过修改生成的 README 投稿。npm 发布和市场收录是两个独立过程，合并和市场显示存在外部等待条件。

在自己的仓库根目录、[package.json](../package.json) 旁加入 `screenshots.json`，列出 1–8 张真实界面截图。截图相对路径留在项目内，展示浅色、深色、批量选择与操作反馈；必须来自实装界面。

如果提供 GitHub Release tarball 回退：`latest/download/` 使用固定、不含版本的资产名；含版本的文件名匹配明确的 release tag。市场条目可使用合规的 GitHub HTTPS `.tgz` 地址。

## 首次发布完成条件

首次公开发布须先完成围绕原生 Archive 的手动核心闭环：归档管理、取消归档、单项永久删除、固定选择的批量永久删除及明确对象范围的清空。原生 Archive 为唯一入口，产品模型以[已选定决策](design-proposal.md#已选定的原生归档产品模型)为准。原生归档管理与取消归档的实现及证据见 README 和验证报告。永久删除的资源生命周期协议与隔离故障验收先通过，再进入公开分发；已有归档与恢复验收不能替代删除验收。具体行为与准入见[设计提案](design-proposal.md)。

- npm 包可通过完整 bundle 安装及卸载，预编译资产均在 tarball 内。
- Windows、macOS、Linux 三类主要平台均须完成隔离验收。每个平台至少覆盖一个明确的 DSH 版本、CPU 架构、文件系统与 JSONL 提供方组合，并通过归档管理、取消归档、单项删除、固定批量及清空、写锁竞争、实际进程终止与重开、cache/index 收敛及 tarball 安装/卸载检查。macOS 的 Intel 与 Apple Silicon、Linux 的 libc 及 Windows 的原生锁差异按支持矩阵分别记录；不能用 macOS 测试或模拟平台的单元测试替代其他系统的实际验收。未支持或未验收组合不能执行删除，证据不足时不得正式发布。
- GitHub 有源码、许可、安装说明、真实截图、支持范围、issue/PR 流程与通过的检查。
- Release 与 npm 发布使用相同提交和构建产物。
- 目录提交只修改本项目条目，满足仓库年龄和内容要求；是否已合并、是否已在市场可见如实记录。
