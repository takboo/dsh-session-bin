# 兼容性自动化与 rc.4 本地验证

日期：2026-10-27。生产依赖仍为 DSH `0.2.1-rc.3` / 插件 `0.2.6`。本轮在 `9e1ece2` 基线上的兼容性自动化实现快照执行；Git 父提交不代表完整实现，候选平台报告的实现清单 SHA-256 为 `4a84c893807b702e11318ab36d7891f9759e0352a2489a92319247c885628482`。

## 本地运行

macOS ARM64/APFS，mise Node `24.18.1` / libuv `1.52.1`、pnpm `11.23.0`。所有会话为独立 fixture，DSH_HOME 位于测试目录；真实会话、安装应用和生产准入未变。

- rc.3 基线完整验证：410 项，404 通过、0 失败、6 项 Windows 检查跳过，真实 Loader 通过。新增监测逻辑另以聚焦测试核对发现、去重、渠道汇合、有限重试、权限、受限提案、缺报告、文档搬迁及 npm 发布等待。
- rc.4 npm 精确发布时间 `2026-10-26T15:28:13.431Z`，由 `next` 发现。下载并核对 registry SHA-512；顶层 tarball SHA-256 为 `1fddead34d3c943b7a4eed1d614e14fa19925803455e28c5141645caf4b02d13`。本轮官方 GitHub Release 与 macOS ARM64 nightly feed 尚未提供 rc.4，不据此声称桌面支持。
- 目标依赖实际解析版本均为 rc.4；类型检查、构建、正常 Loader 的未准入删除拒绝与日志保留通过。
- 18 个关键 SDK 实现文件 SHA-256 与 rc.3 相同。仅在隔离副本生成 rc.4 候选版本/摘要映射，生产源码保持稳定。
- 候选平台完整验证：410 项，404 通过、0 失败、6 跳过；真实 Loader 标记 `candidateDeletionQualified: true`、`productionDeletionQualified: false`。
- 跨 rc.3 → rc.4 冷升级：prepared、done、owner-fenced、resource-effect 各覆盖 raw/zstd，共 8 组通过；沿用原冻结计划与 operationId，重复执行返回相同回执，sibling 日志保持存在。
- 候选中文与 English GUI 各 17 项通过，均标记 `candidate`，不能满足正式发布要求的 supported / productionDeletionQualified。

完整[本地报告](../../.local/compatibility/darwin-arm64-kdO3Wq/report/report.json)、[源码比较](../../.local/compatibility/darwin-arm64-kdO3Wq/report/sdk-audit.json)、[升级日志](../../.local/compatibility/darwin-arm64-kdO3Wq/report/upgrade-verify.log)只属于本轮，忽略目录中的原始证据不随 Git 分发。

## 保留的失败

rc.4 的整体结果为 **failed**。正常未准入 GUI 已确认单项、固定批量和清空均零删除执行，但中文流程在关闭 Host 后的 transcript 深比较失败：已打开原生历史的 `gui-native-only` 增加 `session/end-seed`、`permission/preset`、`sandbox/mode` 和 `approval/policy` 事件。其他候选阶段继续执行并单独报告。

这证明该断言尚未通过，不足以判定 rc.4 的存储不兼容；需区分原生历史初始化的预期追加与删除尝试的影响。本轮没有删除这些断言、忽略差异或将结果改为通过。源码相同、候选通过及零删除执行都不能替代该检查或自动扩大准入。

第一次沙箱内 Chrome 启动被系统拒绝；在沙箱外使用同样的独立 profile 继续后，保留上述真实断言失败。桌面 Electron/ASAR、其他平台、物理输入法及真实用户环境不属于本机证据。

## 自动化边界

流程及状态语义见[自动检查契约](../compatibility.md)与[ADR 0012](../decisions/0012-automated-compatibility-candidates.md)。实际远程 CI 的平台结果、运行链接和依赖草稿 PR 由对应 Issue 保存；候选结果不更新生产支持声明。调度须由维护者将工作流合并到默认分支后生效；本轮不自动合并或发布。
