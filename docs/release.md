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

- npm 包可通过完整 bundle 安装及卸载，预编译资产均在 tarball 内。
- 支持的 DSH 版本与提供方有测试证据；未支持永久删除时描述不声称支持。
- GitHub 有源码、许可、安装说明、真实截图、支持范围、issue/PR 流程与通过的检查。
- Release 与 npm 发布使用相同提交和构建产物。
- 目录提交只修改本项目条目，满足仓库年龄和内容要求；是否已合并、是否已在市场可见如实记录。
