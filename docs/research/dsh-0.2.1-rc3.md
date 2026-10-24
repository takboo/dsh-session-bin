# DSH 0.2.1-rc.3 接口与资源生命周期调研

日期：2026-10-24。基线为插件 `0.2.4` / DSH `0.2.1-rc.2`；目标为 `0.2.1-rc.3`。本文记录一手源码和发布物差异，运行资格另见[兼容性验证](../verification/dsh-0.2.1-rc3.md)。

## 来源与精确版本

上游 [Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.3) 发布时间为 `2026-10-23T15:26:39Z`，tag `dsh-v0.2.1-rc.3` 指向 `1f81c047fc48fa190a683e469daa699857e9afe8`。用户简称 rc3 的 npm 精确 semver 为 `0.2.1-rc.3`，DSH 包发布时间为 `2026-10-23T07:54:30.267Z`。[registry 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)

下载官方 tarball 后逐包检查 registry SHA-512 integrity，解包不运行安装脚本。DSH tarball SHA-256 为 `9a8f9493bfab8218215a8ca38ab8821e76dff63dc4fcb65841ef87c0aa277141`；JSONL 为 `6ceb1f2257f9e2a27b8d772541c0c9c95124f2f4911d1358468115ce9c7b61bb`。源码快照、逐文件比较及 registry 记录保存在忽略目录 `.local/research-rc3/`。[DSH 发布物](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.3.tgz)、[JSONL 发布物](https://registry.npmjs.org/@deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.2.1-rc.3.tgz)

## 宿主协议

`native-retirement-sdk.ts` 审计的全部实现文件以及 Agent/AgentLoop 的 `lib/index.js` 与 rc.2 逐字节相同，SHA-256 沿用[rc.2 清单](dsh-0.2.1-rc2.md#npm-编译实现核对)。Session 格式、JSONL generation/lease/tracker、Workspace 归档活动保护、投影 cache、SQLite 查询、API Session 激活与 idle release 的 Host 实现未变。未新增删除参与方或资源路径，没有新的公共永久删除接口。[固定版本源码](https://github.com/deepseek-ai/deepseek-harness/tree/1f81c047fc48fa190a683e469daa699857e9afe8)、[完整比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.2...dsh-v0.2.1-rc.3)

因此运行时版本检查更新为精确 rc.3，保留源码摘要检查，且继续使用 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md) 的 schema-1 durable 身份。`legacyDurableHostContract = 0.2.0-rc.2`、历史 fingerprint 和 queryProvider 字符串仍为既有协议标识；它们不能改为当前 SDK 版本，也不能授予自动重发或跨 Host 删除能力。源码相同本身不授予新版生产资格。

## history 与目标占用（0.2.6 修复复核）

锁定 [history.ts](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/api/session-controller/src/history.ts) 中，`follow` 在 iterator finally 前保留 `sourceFor` 得到的 query observation；`closeFollowers` 是不带 SID 的全局 Set。`addressId` 对普通会话使用 sessionId，对 subagent 使用 childSessionId。prepared 源在首次 snapshot 之后调用 promotion，不能把 snapshot 送达等同于流已释放。

发布物 `dsh-session-query/lib/index.js` 的 SessionObservationReader 对 prepared observation 增加当前 cache entry 的 refs，live observation 只持有只读内存；新 revision 可以替换 cache entry，旧 observation 仍保留旧快照。后续 promotion 在 `dsh-api-session-controller/lib/index.js` 经 resolveObservedAgent → resumeObserved → registry.resume 激活。两个生产实现文件继续纳入插件既有 SHA-256 核对。由此推导：删除必须保留目标当前 query refs 与后续激活/写入围栏，单靠全局 follower 数量无法判断哪个冷目标仍有资源占用；可执行回归见[定点释放验证](../verification/targeted-deletion-drain.md)。

## 客户端变化

| rc.3 变化 | 本插件影响 |
| --- | --- |
| Sidebar 新增 `sidebar.panellist.actions`、内存 panel pin 状态和 More 菜单。 | 既有 `sidebar.panellist` 的 id/label/order 及 `main` 注册保持；默认 pin 列表为空，插件入口继续显示。 |
| Menu 新增 `current`、`minWidthFromAnchor`；Tooltip 新增视口适配和方向回退。 | 原有调用签名兼容；使用原生控件，通过双语窄屏与键盘 GUI 验收核对实际行为。 |
| Workspace 新会话复用 blank、按 preset 筛选及保留 draft。 | 不修改 Archive 集合或冷会话删除协议；插件仍由 Workspace 公共接口取消归档。 |
| ClientModules 构建身份、Sidebar 版本文本变化。 | 固定新版 SDK，保留原生 Module Loader 及 Remote 的 runtime identity。 |

依据：[Sidebar slots](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-sidebar/src/client/contract/slots.ts)、[panel pin 默认值](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-sidebar/src/client/panel-pins.ts)、[Tooltip](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-primitives/src/Tooltip.tsx)、[Workspace navigation](https://github.com/deepseek-ai/deepseek-harness/blob/1f81c047fc48fa190a683e469daa699857e9afe8/packages/client/ui-workspace/src/client/navigation.ts)。API Session 的声明变化只修改客户端注释，Host 编译实现未变。依赖图除 rc.2→rc.3 替换外，仅新增官方 `dsh-client-ui-entry-customization`；未更新其他依赖版本。release-age 例外只列精确官方版本。

## 官方桌面发布物

通过本机 rc.2 应用声明的[官方 mac-arm64 nightly feed](https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml) 获取 rc.3 ZIP，独立解压到 `.local/research-rc3/desktop/`，不替换 `/Applications` 中的应用。ZIP 大小 `347702586` 字节，SHA-512（base64）为 `0tCeP/zLGLtsH+S4BD4TIyRJ8TwRhh7xaJprTMOUoEfj7hYJFC3G5l6nl/2zCTS41MeE9k+KRN19RE9sqX6goQ==`，与 feed 一致。[官方 ZIP](https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.3-mac-arm64.zip)

实际二进制及 ASAR `desktop-runtime.json` 一致报告 DSH `0.2.1-rc.3`、Electron `44.7.0`、Node `24.21.0`、libuv `1.52.1`、ABI `149`、SQLite `3.53.4`、Zstd `1.6.0`，Host protocol 仍为 `4`。现有运行时载体准入无需放宽；rc.3 ASAR 的源码检查和生命周期仍需独立运行验收。

2026-10-24 重新核对 [npm trusted publishing 规则](https://docs.npmjs.com/trusted-publishers/)：受支持托管 runner、`id-token: write`、npm ≥ `11.5.1` / Node ≥ `22.14.0`、精确 publisher workflow 及允许 `npm publish` 的要求仍适用。继续使用 tag 工作流发布同一验收 tarball，不新增长期 Token。
