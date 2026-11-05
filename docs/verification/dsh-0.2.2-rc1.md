# DSH 0.2.2-rc.1 适配与恢复验证

日期：2026-11-05。正式依赖目标为 npm 精确 `0.2.2-rc.1`，Cordis `4.1.0`、Loader `1.1.0`、Schemastery `3.19.0`；插件版本 `0.3.0`。维护版本 `0.2.9` 单独向 DSH `0.2.1-rc.5` 提供同一缺锁修复，见 [PR #26](https://github.com/takboo/dsh-session-bin/pull/26)。本报告记录本轮实际结果，最终生产发布还须通过对应提交/tag 的五平台 CI。

## 原始失败与源码审阅

原 [Issue #25](https://github.com/takboo/dsh-session-bin/issues/25) / [官方 Desktop 候选](https://github.com/takboo/dsh-session-bin/actions/runs/41920677461) 的 ASAR suite 停在 Cordis `4.1.0` 与旧审计 `4.0.5` 不匹配；这是正常的未审阅拒绝，不能简单改版本断言。当前工作区从旧依赖重新运行隔离候选，保留[原失败报告](../../.local/compatibility/darwin-arm64-ebPNdt/report/report.json)：目标类型/正常未准入 Loader 通过，候选生命周期与旧计划恢复失败。更新 JSONL 实例源码身份后，文件和完整真实 owner 检查通过，metadata 中仍有 19 项失败，定位为旧历史类已移除及 JSON storage 行为变化。

逐项审阅参与包的实际 npm 源码和官方 ASAR：JSONL 增加 stat location，writer lease、物理代际和规范路径不变；SessionStore 对未进入/未宣布及已移除 Session 的追加保护增强；Workspace/query/cache 的冻结资源语义保留。API Session 将 `SessionHistoryController` 分拆为 `HistoryController` 和 `WebController`，快照与被动监听不再共用 observation 寿命。Cordis 4.1 对取消中的启动结算使用新 epoch 语义；测试继续核对非活动 fiber、句柄、domain 和 lease 释放，不再要求旧启动 promise 抛出错误。审计表与 JSONL 实例摘要精确绑定新版，旧 schema 1 durable fingerprint、store/lifecycle、grant、回执及 queryProvider 字符串保持不变。

新版 JSON storage 的通用 `deleteRecord` 会先将文档改名为 `.json.deleting`，再以 allSettled 清理；清理拒绝可能不导致该方法拒绝。新增回归在修复前明确失败（残留未被识别），修复后目标残留一律拒绝。POSIX owner 在既有写队列中复核 exact 文档并直接清除，确认实际缺失；Windows 继续使用已冻结身份的既有专属 stage 协议。不存在读取不可见即已清除的推断。

## 当前实现与定向验证

- metadata 共 **48 项通过**：三类安装后订阅按目标排空；安装前被动快照读毕后 refs 为 0，实际未结束的 observation 仍拒绝删除；捕获安装前 Web 方法不能重新激活退役目标；原生活动、外部 Agent、独立句柄与 sibling 流保护保持。
- 兼容性监测 **15 项通过**，包括提案年龄策略的失败→通过回归。仅额外接受从冻结 SDK 图可达的官方精确版本；通配符/范围、其他包、不可达包、缺少原豁免和其他策略改动仍拒绝。原 rc.1 的真实依赖提案已用新校验器通过，而不是跳过校验。
- Cordis 取消中的三项独立回归通过；真实 Loader 生命周期回归通过，使用与宿主一致的 `1.1.0`。

## 实际载体与冷升级

独立下载官方 `0.2.2-rc.1` macOS ARM64 ZIP，核对 feed SHA-512、归档路径以及 DeepSeek `NAN929V4UM` 签名；没有替换已安装应用。载体为 Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1` / ABI `149`、APFS，SQLite `3.53.4` / zstd `1.6.0`。

[实际 ASAR 全量报告](../../.local/desktop/darwin-arm64-qTC2OK/verification.json)通过：**470 项，464 通过、0 失败、6 项 Windows 专用跳过**，源码前后稳定，清单 SHA-256 为 `cbc82a997728373f07bfa96bc49ed48d8a38c8a2e80aa862d3e6a327c108610f`。本轮正式源码没有 candidate marker 或环境准入绕过。

首轮 Node `24.18.1` 的真实 Loader 与中文/English Web GUI 均通过，两种语言各 **18 项**；[中文报告](../../.local/gui/client-zh-eskKw8/verification.json)及[English 报告](../../.local/gui/client-en-LWhML2/verification.json)使用同一 tarball，SHA-256 为 `04c006ac23150d7d4073ce98171262f5eeb259fae2c4dabc62be3d8ffe1f4ffc`。console/pageErrors 为空，覆盖单项/批量/清空、打开原生历史、准备取消、实际删除、重开和连接握手断言。

同步当前 README/契约后的最终本机检查也全部通过：

| 验收 | 结果与证据 |
| --- | --- |
| Node `24.18.1` / macOS ARM64/APFS 完整 verify | [平台报告](../../.local/platform/darwin-arm64-2UweQV/verification.json)：文档/市场静态检查、两端类型、构建、470 项（464 通过、6 跳过、0 失败）与真实 Loader 全部通过；源码摘要同上 |
| 同一正式 tarball 的 Node Loader | [Loader 报告](../../.local/lifecycle/package-H493k7/verification.json)，production 为 true、candidate 为 false |
| 官方 rc.1 Electron/ASAR production probe 与双语 Web GUI | [Desktop GUI 汇总](../../.local/desktop/darwin-arm64-kEbvyE/verification.json)、[中文](../../.local/gui/client-zh-Q65Q3j/verification.json)、[English](../../.local/gui/client-en-jtnGJh/verification.json)：每语言 18 项，零 console/pageErrors，四次关闭均自然结束 |

最终 Loader 和两种语言 GUI 的 tarball SHA-256 相同：`cdf1371188cb91412fae3f3a069bdf822dc5ae424973f6d9ea98d3104b7af0fa`。首轮 `04c006ac…` 属于文档同步前的同一实现检查点，不作为最终发布包身份。实际公开产物仍须使用 tag 流水线已经验证过的 Linux x64 tarball，以 `release.json` 为准。

rc.5 → rc.1 冷升级的 raw/zstd × prepared/done/owner-fenced/resource-effect **8 组全部通过**：原 frozen plan 和 operationId 不重建，显式执行及历史幂等得到成功，目标确实缺失、sibling 保留。样本在同一隔离目录先由旧 SDK 生成并在相关边界实际 SIGKILL，再冷切换依赖/源码；没有复制路径后重绑定生命周期。原始日志见[冷升级结果](../../.local/release-0.3.0/cold-upgrade.log)。

所有真实清除、缓存、SQLite 和故障样本均在临时 DSH_HOME/独立 fixture 中。旧 `0.2.2-alpha.2` / `alpha.3` 未被加入白名单，保留原失败并由 rc.1 后继版本取代；新 SDK 通过不表示旧 alpha 兼容。不声称覆盖原生 Desktop shell、物理输入法、真实账号模型请求、断电恢复或未实际验证的其他组合。
