# 0.2.4 原生历史就绪与发布验证

日期：2026-10-18。基线为 `bafd410cfd710823e44407720525e64d29592ef6` / `v0.2.3`，目标为 DSH `0.2.1-rc.2`、插件 `0.2.4`。桌面运行时准入修复及原有独立资格证据见[桌面验证](desktop-runtime.md)。

## 失败基线与根因

`v0.2.3` 的[正式标签验收](https://github.com/takboo/dsh-session-bin/actions/runs/39095814612)中，四个平台通过；Windows 第一次英文、第二次中文 GUI 均因 `Sidebar Session opening failed: Session reference "gui-native-only" is released` 未通过。两次的全量平台及 Loader 检查均通过，但 GUI 未完成 SDK 重开与卸载验收，因此发布门禁正确阻止了 GitHub Release 和 npm；`v0.2.3` 标签保留，不移动或替换。

上游 `SidebarSessionView` 订阅 `reference.ready` 的拒绝并记录错误；`ClientSessionReference.release()` 会拒绝仍未完成的 ready。直接使用 rc.2 原始类、仅擦除 TypeScript 类型、不加载本插件即可重现相同警告。[独立复现](../../.local/debug/sidebar-release-repro.json)；一手代码见 [SidebarSessionView](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-sidebar-right/src/client/session-view.ts)、[ClientSessionReference](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/client/sessions/service.ts)。

旧 GUI 脚本点击历史后仅检查任意 tab 和 editor 可见，没有证明所选 Session 历史已就绪。在 Gateway 的真实 `session/follow` WebSocket 打开帧上增加 1.5 秒延迟后，本地也出现同一警告；继续过早操作还触发资源作用域变化拒绝，未越过身份保护。[修复前报告](../../.local/gui/client-en-iREVEk/verification.json)

## 修正与定向回归

隔离 fixture 记录两轮已完成的真实 SDK 历史。两次打开都等待目标 `data-conversation-session` 下的原生轮次导航，确认两轮均为已加载的“跳转”入口，再确认对应原生侧栏和编辑器。导航仅在上游 `openState === open` 初始化滚动后渲染；与仅等待编辑器可见相比，这证明了目标历史已完成打开。一手依据见 [ChatView](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/chat/ChatView.tsx)、[useChatScroll](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-chat/src/client/chat/use-chat-scroll.ts)。

正式 GUI 保留慢历史流回归：只延迟独立样本的打开帧，同流后续帧按顺序转发；其余流及服务端响应不变，数据来自真实 Host。报告必须证明实际延迟已发生、两次打开各确认两轮已加载历史，原 17 项检查、零 console/pageErrors、固定删除请求、物理日志、SDK 重开及正常卸载退出全部保留。

同一延迟复现场景修正后通过：2 次延迟、2 次就绪证明、17 项检查，零 console/pageErrors，两个 Host 均正常退出。[修复后报告](../../.local/gui/client-en-sZbYVu/verification.json)

## 0.2.4 本地完整验收

最终实现提交为 `a91224e153d31755a6ca76709f9d942272862ecc`；源码清单 SHA-256 为 `5897ad233ae290ab31b3cb8d9d8428dc82fd5ca2d324408a4cbb67f481c13c66`。固定 Node `24.18.1` 的[完整平台报告](../../.local/platform/darwin-arm64-asIIVH/verification.json)通过类型、构建、391 项回归及实际 tarball Loader；实际桌面 Electron `44.7.0` / Node `24.21.0`、真实 ASAR SDK/native modules 的[完整报告](../../.local/desktop/darwin-arm64-LVVABv/verification.json)也通过。两者均为 385 通过、0 失败、6 项 Windows 专用检查跳过，源码前后稳定。

实际 Electron 载体上的 npm Web Host/Client [双语 GUI 报告](../../.local/desktop/darwin-arm64-fXOvUE/verification.json)通过。中文、英文各 17 项，分别记录 2 次真实历史流延迟、2 次目标历史就绪；console/pageErrors 为空，四次 Host 均正常退出。ASAR production probe 仍逐项核对 18 个 SDK 文件，生产准备无 blocker。Loader 与两种 GUI 使用相同 tarball，SHA-256 为 `1aecdda6acf2fedc31d5a235d6e713e96c716f48973fcb7918c14ad5713ed3b5`。

再次从已发布 `0.2.2` 的 dist / Node `24.18.1` 建立独立旧样本，用本次构建及实际 Electron/ASAR 冷重开；prepared、done、raw/zstd 的 owner-fenced、resource-effect 共 6 个场景全部通过，原授权和回执保持，sibling 完整。[升级报告](../../.local/desktop-upgrade-verification.json)、[中断恢复报告](../../.local/desktop-upgrade-crash-verification.json)

## 五平台完整 CI

[PR #12 验收](https://github.com/takboo/dsh-session-bin/actions/runs/39097691205)在上述实现提交上首次全部通过。下载并核对全部 20 份报告：DSH `0.2.1-rc.2`、独立 Node `24.18.1`，源码前后稳定，生产 Loader 资格成立，双语各 17 项，分别包含 2 次真实慢历史流与 2 次就绪证明，console/pageErrors 为空，Host 安装及卸载后均正常退出。[汇总](../../.local/ci-history-pr/summary.json)

| 平台 | 文件系统 | 全量、Loader、中文和英文 GUI |
| --- | --- | --- |
| Windows x64 | NTFS | 全部通过 |
| macOS ARM64 | APFS | 全部通过 |
| macOS Intel | APFS | 全部通过 |
| Linux ARM64 | ext4 runner | 全部通过 |
| Linux x64 | ext4 runner | 全部通过 |

POSIX 源码摘要与本地最终报告相同，Windows checkout 字节摘要为 `361dd020536ae2952c06e2eb711d10af367065e3728b5d5b290065cdcbaba163`。每个平台的 Loader 和两种 GUI 使用相同 tarball；Linux x64 发布候选产物与本地最终桌面 GUI 的 tarball 摘要相同。该矩阵复核原独立 Node 五平台支持范围；新增 Electron 桌面资格仍仅为独立验证的 macOS ARM64/APFS 组合。

全部操作使用临时 DSH_HOME、独立 profile 和 fixture。修正不改变上游对提前释放 pending 引用的告警行为；快速取消未完成的宿主历史打开仍可能记录该告警。运行时准入、资源身份与活动保护维持原契约，不因此扩大桌面平台资格。
