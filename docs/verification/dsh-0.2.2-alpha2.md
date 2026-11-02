# DSH 0.2.2-alpha.2 隔离检查

日期：2026-11-02。基线为 `de95af6d34afb10e930df6ab1b70a3d7df9364c9`（插件 `0.2.7` / DSH `0.2.1-rc.5`），本轮只为导出的 `Config` schema 增加显式公共类型。正式依赖、SDK 指纹、删除准入、durable 协议身份及平台/运行时范围不变。目标为官方 [alpha.2 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-alpha.2) / npm 精确发布物；顶层 tarball SHA-256 为 `3c8fd2338d0e89b1a72484abc22fc9f7452088a5ad8e122566065ef5a803ea7a`。

## 编译阻塞及修复

[原五平台运行](https://github.com/takboo/dsh-session-bin/actions/runs/40640335099)均停在 `target-types`。下载 Linux x64 原始 artifact 并核对 ZIP SHA-256 `f59244198e9eb8579b82d656e73e85ddcfad1e34ffb6ee434ab91ce57b525bd3`，日志为 `src/index.ts(52,14): TS2742`：推断的配置 schema 类型需要引用 pnpm 内部的 `@deepseek-ai/schemastery@3.18.6-alpha.1` 路径。

在当前基线的新临时副本上，以 `DSH_VERSION=0.2.2-alpha.2 mise run compat:check` 再次复现相同错误。随后仅将 `export const Config` 标注为直接依赖导出的 `schema<Config>`；同一副本的 `pnpm run check` 通过，再以新的独立副本重跑兼容性任务，目标类型及构建通过。没有用强制类型转换、关闭 declaration 检查或更新顶层 Schemastery/Cordis 依赖消除错误。原始复现见[类型失败报告](../../.local/compatibility/darwin-arm64-RXYRZ0/report/report.json)。

修复后的 rc.5 基线 `mise run verify` 通过：435 项测试，429 通过、0 失败、6 项 Windows 专用检查跳过；真实 tarball Loader 的 production 为 true、candidate 为 false。此结果只证明当前正式基线未发生已测回归，不证明 alpha.2 支持。

## 依赖提案拒绝

原始 `target-lock.log` 记录 pnpm 自动增加 33 条 `minimumReleaseAgeExclude`，包括 Cordis/Schemastery alpha 依赖及新增 DSH 包；因此报告器的精确策略比较拒绝创建草稿 PR。这是受控提案校验的实际拒绝，不能通过接受任意新豁免或只比较 YAML 格式解除。本轮重新生成的策略文件与基线只替换精确 DSH 版本后的内容完全相同；保留原校验和原始失败，不放宽 release-age 策略。

## 正常拒绝与候选失败

本机为 macOS ARM64/APFS，mise Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`。所有操作使用临时 `DSH_HOME`、独立 fixture 与浏览器 profile。

修复类型后，未改生产准入的 alpha.2 构建通过真实 Loader 拒绝检查；在允许启动 Chrome 的环境中，中文与 English GUI 各 17 项通过。单项、固定批量及清空均保持未准入、零删除执行，关闭并重开后原始日志字节保持。报告见[中文](../../.local/compatibility/darwin-arm64-I8sbjx/workspace/.local/gui/client-zh-lWh945/verification.json)和 [English](../../.local/compatibility/darwin-arm64-I8sbjx/workspace/.local/gui/client-en-Bn5INz/verification.json)。

隔离候选构建仍不兼容：全量 435 项中 368 通过、61 失败、6 跳过，跨 rc.5 → alpha.2 恢复也失败。失败包含 owner 未能建立、`SessionHistoryController is not a constructor`，以及依赖该 owner 的固定批量、活动保护与恢复场景。编译通过没有恢复这些生命周期能力，不能跳过这些断言或自动刷新正式指纹以宣称支持。[候选失败报告](../../.local/compatibility/darwin-arm64-A5PRMV/report/report.json)保留完整阶段、源码审计和日志。

第一轮正常/候选 GUI 因沙箱内 Chrome 启动 SIGABRT、清理进程 EPERM 记为 retry；这与候选生命周期的实际断言失败分别保留。允许浏览器启动后的[完整独立运行](../../.local/compatibility/darwin-arm64-I8sbjx/report/report.json)同样为 failed：全量仍为 368 通过、61 失败、6 跳过，升级恢复失败；候选中文 GUI 完成 11 项后，删除准备仍返回未支持，预期可执行的断言失败，后续候选 English 未执行。正常拒绝的两种语言已独立通过，不能把它们计作候选删除通过，也不覆盖原始失败。

本轮 18 个受保护 SDK 实现文件有 9 个摘要变化，涉及 Session、JSONL、Storage、API Session controller、Agent/AgentLoop。该自动差异清单不等同于完整源码审阅。副本实现清单 SHA-256 为 `7448a6611ba6df57c3e82c4b362ffbc4b56fae53ac89f5e5a71f53e69878c16f`；报告的父提交为上述基线、sourceDirty 为 true，实际代码差异只有显式配置类型声明，原仓库生产准入文件前后稳定。

## 资格边界

本轮读取的官方 [macOS ARM64 nightly feed](https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml)仍为 `0.2.1-rc.5`，alpha.2 GitHub Release 没有附件；没有对应官方 Electron/ASAR 载体可供独立资格验证。不能用 rc.5 桌面或 npm 重组载体替代。

alpha.2 后续必须完成宿主生命周期和历史/投影接口迁移、固定对象及活动/引用/未知状态保护、全量候选与冷升级恢复，再审阅正式准入并独立验收实际组合。当前结论仍是未支持；[Issue #19](https://github.com/takboo/dsh-session-bin/issues/19)保存后续证据与完成条件。

## 0.2.8 的 rc.5 发布验证

配置类型修复为 [33fc9be](https://github.com/takboo/dsh-session-bin/commit/33fc9bedf94d0ad42e1216fad8e594fd631b7f7f)，`0.2.8` 版本准备为 [2a75978](https://github.com/takboo/dsh-session-bin/commit/2a75978461c109af2b33728f3f3c303c5c4d27af)，由 [PR #22](https://github.com/takboo/dsh-session-bin/pull/22) 交付。只改变配置类型导出、插件版本及文档；SDK、依赖锁文件、运行时/平台范围和永久删除保护沿用已验收的 rc.5。

2026-11-02，以正式 `0.2.8` tarball 在本机 macOS ARM64/APFS 独立验收：

- Node `24.18.1` 的类型、构建、frozen install 与真实 Loader 通过；Loader 为 production、candidate 为 false。
- 重新完整验签的官方 rc.5 应用，实际 ASAR/native modules、Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1` 全量 435 项：429 通过、0 失败、6 Windows 专用检查跳过；源码前后稳定。实际 ASAR Loader 也通过。
- 同一官方 Electron 运行的中文/English Web GUI 各 17 项通过，均为 supported、production 为 true、candidate 为 false。console/pageErrors 为空，四次 Host 关闭均为 code 0、signal null、forced false；包括实际删除、重开、固定批量、清空、两次延迟原生历史读取和确认设置检查。
- 两份 Loader 与两份 GUI 使用相同 tarball，SHA-256 为 `0b0f65a0c3cae6004f66113aa493f525339dc5160441df40b9bb00104f162163`。[独立证据核对结果](../../.local/release-0.2.8/release-0.2.8-accepted-local.json)逐份核对实际 Node/Electron、源码稳定、生产标记、GUI 项目及 tarball 字节。

本机完整实现清单为 `d403a930eb1d01d7f70344c3060ca3149d6c55195e53f142e4778fd3ec72ec1d`；仅扣除两份既有、Git 忽略的 Finder 元数据后，干净 124 文件清单为 `a1fc723065561bdcdf6ce4fcead47a811a5936cd2e453072706a36600735d967`。文档不参与实现清单；最终 PR/CI 还须逐文件核对，Windows 按实际 LF/CRLF 核对，不能忽略未知差异。

首次两次单独调用 ASAR Loader 时未传入 pnpm 执行入口，检查器在打包前明确拒绝；通过 mise 和显式固定的 pnpm 入口复验后通过。失败调用日志保留在同目录，不计入上述完成证据。没有关闭验证器的包管理器检查。

完整五平台正式报告以 [PR #22 最终提交检查](https://github.com/takboo/dsh-session-bin/pull/22/checks)为准；`v0.2.8` tag 必须重新通过全部五平台及同轮 Loader/双语 GUI 门禁，再由 Linux x64 已测试的同一 tarball 发布 GitHub Release/npm，最终身份以 `release.json` 为准。这里只修复声明编译问题，没有 alpha.2 的生产支持或原生 Desktop shell、物理输入法、真实用户会话验收声明。

## CI 浏览器选择修正

上述 `08f1559` 实现的 [PR CI](https://github.com/takboo/dsh-session-bin/actions/runs/41413739187)五平台通过，20 份报告逐份核验通过；同提交 [push CI](https://github.com/takboo/dsh-session-bin/actions/runs/41413730763)的 Intel job 连续三次被宿主 `generation is still not ready after 3000ms` 警告拦截。失败 artifact `13127590258`、`13127572807`、`13128088867` 已备份，原运行没有改写为通过。

独立 Intel 诊断中，单语言 GUI、无前置全量的双语启动器、全量后单语言 GUI 均通过，未复现警告；本机 6 倍 CPU 限速下的启动及完整中文 GUI 也未复现。因此没有把启动器、前置负载、历史流注入或产品启动逻辑单独判为根因，也未延长阈值或放宽零警告、删除及恢复断言。

报告比对另发现可确定复现的配置缺陷：CI 虽安装 Playwright `1.56.0` 的配套 Chromium，选择器却优先启动系统 Chrome `151.0.7922.174`。这违反了声明的锁定浏览器基线；[Playwright 一手文档](https://playwright.dev/docs/browsers)要求每个版本使用匹配的浏览器二进制。

三项选择回归在旧实现全部失败：CI 选择系统 Chrome、缺少锁定浏览器时静默回退、显式 override 失败后改用其他浏览器。修正后连同原平台/worker 检查共七项通过。`CI=true` 仅接受指定 override 或配套 Chromium，缺失直接失败；普通本机查找顺序保持。本次不声称已确定所有慢握手警告的根因；后续正式 CI 必须记录锁定浏览器来源，并重新通过原有全量及双语 GUI 门禁。

### 浏览器选择修正后的正式构建

前节 `0b0f65a0…` tarball 和 435 项报告属于修正前的 `0.2.8` 首轮实现，保留为历史证据。浏览器选择修复为 `011f02f`；以下独立正式检查使用修正后的源码和同步后的发布文档。产品运行时 JavaScript 与两份语言资源逐文件匹配已发布 `0.2.7`，变化限类型声明、source map、包版本和文档；测试辅助脚本不进入发布包。

本机正式 Node Loader 与实际官方 ASAR Loader 均通过；官方 rc.5 Electron 的全量回归为 438 项，432 通过、0 失败、6 项 Windows 专用检查跳过。两份正式 Loader 与官方 Electron 上的中文/English GUI 各 17 项均通过，production 为 true、candidate 为 false；GUI console/pageErrors 为空，四次 Host 关闭均正常、无强制终止。四份报告使用相同 tarball，SHA-256 为 `703de530a0004ac8bc0f93faa0a8a31a3f90ab4c7fea67a96e0ee6b53cf24ab0`。[本机证据核对](../../.local/release-0.2.8/browser-fix/release-0.2.8-accepted-local.json)确认实际运行时、源码稳定、历史加载、实际删除与重开及同字节产物。

本机实现清单为 `4c8d994d71b3c033e95d4ec289b30e0a98666a00f4171061969eda50473849cd`，扣除既有两份 Finder 元数据后的干净 124 文件清单为 `ee2a4ccbaf2211b28a3a190617547464659f62de70f622f01e534cac79a524e2`。最终五平台/发布报告须重新匹配此清单；不能沿用修正前清单。

修正后的 [Intel 双语诊断](https://github.com/takboo/dsh-session-bin/actions/runs/41423096493)实际选择 Chromium `141.0.7390.37`，来源为 `configured-tool-cache`，两种语言各 17 项、零警告；它仍只是诊断，正式资格以 PR #22 最终提交及 tag 的完整五平台门禁为准。诊断中一次资源采集因 runner 缺少 `rg` 提前终止，没有产生 GUI 结果，未计作 GUI 失败或通过；修正为系统工具后重新执行。未保留临时诊断日志代码或精简 workflow 到正式修复分支。
