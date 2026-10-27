# DSH 新版本检测与候选兼容性检查

生产支持仍由 [README](../README.md#兼容性)、精确 SDK 源码准入和独立组合验收决定。本流程自动收集证据、准备依赖提案，不授予生产永久删除资格，也不自动合并、打 tag 或发布。

选定的隔离与准入边界见 [ADR 0012](decisions/0012-automated-compatibility-candidates.md)。

## 自动检测与报告

[Monitor DSH compatibility](../.github/workflows/dsh-compatibility.yml) 在默认分支每小时第 17 分钟检测 GitHub 已发布 Release（含 rc）、npm `latest`/`next` 和官方 macOS ARM64 桌面 nightly feed。GitHub 计划任务可能延迟，公开仓库长期无活动时可能被停用；任务须合并到默认分支后才会定时运行。手动 workflow_dispatch 可指定精确 npm 版本或 `dsh-v` tag。

沿用 [dsh-usage-state 的检测与 Issue 机制](https://github.com/takboo/dsh-usage-state/blob/main/.github/workflows/dsh-compatibility.yml)：发现、检查和报告分离；开始检查前先写入 running 状态与尝试次数，避免中断后无限重复；按版本维护一个 Issue，只有机器人或仓库所有者的有效状态标记参与去重。发布物 identity 包括 npm integrity、Release/commit 和匹配桌面发布物；渠道汇合更新原 Issue，新增发布物可补跑，不自动降级。每轮至多处理三个版本。

网络、安装准备、超时、任务中断或缺报告记为 `retry`；间隔至少六小时，每个发布物 identity 最多自动尝试三次。断言失败为 `failed`，不自动无限重试；手动精确版本可复验。源码审阅及桌面资格尚未完成的候选成功结果为 `partial`，不写作生产支持。Issue 保存基线、目标来源、平台结果和 Actions 链接；Artifacts 只保留报告、必要日志及失败截图，保留期 14 天，依赖、浏览器、测试会话与真实用户数据不上传。

候选验证在五个独立标准 runner 执行：Windows x64、macOS ARM64/Intel、Ubuntu ARM64/x64。检查 job 只有读取权限；报告 job 才有 Issue、草稿 PR 与分支写权限，PR 事件不运行写入 job。机器人创建草稿 PR 需要仓库允许 GitHub Actions 创建 PR；创建失败会保留 Issue 与依赖提案并报告原因。验证直接在同一 workflow 串联，不依赖机器人 PR 自动触发 CI。

## 受控更新与永久删除边界

所有测试在新建 `.local/compatibility/<platform>-<arch>-*/workspace` 中执行，设置临时 DSH_HOME，使用 fixture；不读写真实 `~/.dsh`。工具保持 mise 固定版本。根目录的 package.json、锁文件及生产 SDK/平台白名单不因检查而变化。

1. 记录目标版本、npm SHA-512 与顶层 tarball SHA-256；先用 frozen lockfile 准备基线，生成 prepared、done、owner-fenced 和 resource-effect 的 raw/zstd 跨版本样本。
2. 在副本中只更新显式列出的官方 DSH 精确依赖及 release-age 例外，生成并冻结 lockfile，记录实际解析版本；禁用安装脚本。不自动更新 Node、Electron、其他顶层依赖或删除协议。
3. 使用未改源码准入的正常构建运行类型、Loader 和双语 GUI。未准入新版须明确拒绝单项/批量/清空，验证零执行和日志保留；源码指纹参与报告资格判断，不能只凭 OS 判定。显式打开原生历史后，以只读 JSONL Context 观察已持久化的初始化事件并冻结删除前快照；该 Context 不挂载 Workspace/domain，也不取得写所有权。只允许该历史窗口内已审计的四类初始化事件追加，保留原始事件及压缩字节前缀，其他会话完全不变；每次删除准备/取消窗口前后及最后重开均逐事件、逐字节比较，不允许插件删除尝试追加或改写日志。
4. 只在隔离副本中生成候选源码版本/摘要映射，保留 durable 协议身份。源码差异完整记录；JSONL 类身份、生命周期、活动保护、资源范围等断言不放宽。运行完整平台回归、旧冻结计划/中断样本恢复、真实 Loader 与双语 GUI。已知验证失败仍保留，并继续收集独立阶段证据。
5. 候选报告标记 `candidate`，不能满足发布所需的 productionDeletionQualified / supported 条件。正式代码没有环境变量准入绕过入口。源码审阅与官方桌面 Electron/ASAR 验收另行完成；feed 未提供对应桌面包时记为等待，不复用旧版资格。

依赖提案仅包含 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`，报告 job 重新核对文件白名单、目标版本、原 manifest 和策略。草稿 PR 保持原有生产准入、运行时/平台范围与插件发布版本，关联对应 Issue。自动化不会覆盖已有提案或维护者修改；后续证据仍写入 Issue，维护者决定是否更新分支。

候选通过不能自动晋级。准入变更必须经过源码审阅，并在对应实际组合上通过正式构建的删除及恢复验收；最终合并和发布仍由维护者决定。

本轮 rc.4 本地结果与保留的失败见[自动化验证](verification/compatibility-automation.md)。

## 本地执行

先完成 README 的固定工具与依赖准备：

```sh
mise run compat:discover -- --local
DSH_VERSION=0.2.1-rc.4 mise run compat:check
```

`compat:discover --local` 只读查询上游，不访问 Issue；可用 `DSH_VERSION` 固定版本。`compat:check` 默认运行正常拒绝与候选双语 GUI，需要可用 Chromium；`--no-gui` 仅供诊断，报告保留未覆盖范围。每次生成独立目录，不复用上轮测试会话。命令结果写在该目录的 `report/report.json`，终端同时输出目录位置。

本地检查不创建 Issue/PR。写入由默认分支的 report job 完成；同一 workflow 的 PR 验证只读，并忽略持久 Issue 状态以复验本次代码变更；定时任务仍遵守去重和有限重试。此自动化不调用付费 AI 服务。标准 GitHub-hosted runner 在公开仓库的运行分钟免费，Artifact/缓存仍遵循账户额度与 GitHub 当前计费规则。

## 复用来源

发现、状态标记、有限重试和 Issue 报告沿用 `takboo/dsh-usage-state` 的 `scripts/compatibility` 思路并调整为本项目的精确存储契约。复用部分保留 Copyright (c) 2026 takboo 与 [MIT 许可](../scripts/compatibility/LICENSE)。
