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
