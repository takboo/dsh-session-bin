# DSH 0.2.1-rc.1 接口与资源生命周期调研

日期：2026-10-17。比较基线为 DSH `0.2.0-rc.2`，目标为用户指定的 `0.2.1-rc.1`。本文记录一手源码与 npm 发布物的差异；源码相似、类型通过或 candidate 验收均不等同于永久删除的生产资格。实际结果由[兼容性验证](../verification/dsh-0.2.1-rc1.md)、[Host 验证](../verification/host-lifecycle.md)与[客户端验证](../verification/client-interface.md)分别记录。

## 版本和来源

- npm 的准确 semver 为 `0.2.1-rc.1`，`@deepseek-ai/dsh` 于 `2026-10-17T03:17:24.154Z` 发布。调研时 npm `next` 已指向同日稍晚发布的 `0.2.1-rc.2`，`latest` 仍为 `0.2.0-rc.2`；因此验收必须固定完整版本，不能用 dist-tag 替代。本轮不推导 rc.2 支持。[npm registry 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)
- 上游 Release 为 `dsh-v0.2.1-rc.1`，发布时间 `2026-10-17T05:22:10Z`；tag 指向 `1600d8a1e140dcde43a1a0941940a0480712c011`。比较基线 tag `dsh-v0.2.0-rc.2` 指向 `639ed015397290b3745d163aafe02ffee4aa3f84`。[目标 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.1)、[固定目标源码](https://github.com/deepseek-ai/deepseek-harness/tree/1600d8a1e140dcde43a1a0941940a0480712c011)、[比较基线源码](https://github.com/deepseek-ai/deepseek-harness/tree/639ed015397290b3745d163aafe02ffee4aa3f84)
- 调研逐项下载 registry 指定的 tarball，没有运行其安装脚本。`@deepseek-ai/dsh` tarball SHA-256 为 `6d0c6fe8ad0c21797a27d6afc0cb69a022714ea0cd7331e4cba8b07b8ce19009`；JSONL tarball 为 `825397df9392e017bcbeff47da91a77cced372a14e83b4e3934abfeafcb9fb70`。原始 tarball、registry dist integrity 与逐文件清单位于忽略的 `.local/research-rc1/`，不是发布依赖。[DSH tarball](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.1.tgz)、[JSONL tarball](https://registry.npmjs.org/@deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.2.1-rc.1.tgz)

## 需要修复的接口断点

**旧版插件不能仅修改兼容性声明。** JSONL 默认导出的服务类已移除；该包现在通过命名导出的 `name`、`Config`、`apply` 作为 Cordis 插件挂载内部 `JsonlSessionPersistence`。`apply` 让 tracker 的路由和句柄保留到依赖消费者卸载完成。因此旧的 default import、`instanceof Jsonl` 及直接构造服务的 fixture 需要改为当前插件入口；运行实例仍须复核具体类型、配置、源码和 tracker 结构。[JSONL 入口](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/session/session-persistence-jsonl/src/index.ts#L1804)、[tracker 释放顺序](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/session/session-persistence-jsonl/src/storage.ts#L521)

API Session 的 `createOrAdopt` 已删除，`createSession(request)` 现在复用符合条件的空会话，否则创建新 ID。`resumeObserved(sessionId, observation)` 保留；`claim(sessionId, request)` 可直接 resume 既有空会话；`createAgent(sessionId, cwd, composition)` 是新建的汇合点。旧 adapter 检查和包装 `createOrAdopt` 会失败；如继续持有精确 API AgentHandle，必须覆盖上述实际 create/resume 调用，不能将按 ID 查到的其他 owner Agent 当作可释放能力。[激活与复用实现](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/session-controller/src/agent.ts#L259)、[resume/claim/createAgent](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/session-controller/src/agent.ts#L424)

官方 CLI 依赖同时调整为 Cordis `~4.0.5`、Loader `~1.0.6`、Schemastery `~3.18.5`；沿用旧精确 SDK 依赖可能产生重复服务身份。需要同步声明及 lockfile，并用真实 profile 验证浏览器共享模块身份和 Loader 注入。[官方 CLI manifest](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/apps/cli/package.json)

Gateway 新增必需的 `remoteAccess` 注入：`TypertGatewayService.inject` 从 `['typert']` 改为 `['typert', 'remoteAccess']`。缺少它时 Cordis 保留待依赖插件，不能取得 `ctx.typertGateway`。隔离 Remote fixture 应先挂载正式的 `RemoteAccessService` 再挂载 Gateway；官方 base bundle 已组合该服务。Gateway 调用也不再创建默认 operator Peer，`InvokeRemoteRequest.peer` 和 `wireStream.open` 的 Peer 均须显式传入。Connection 的旧 `operator` 改为 `browserPeer`，它是认证浏览器所共享的 owner；另一个独立 owner 可通过 `connection.createPeer({ principal: { kind: 'owner' } })` 创建。owner 调用不走资源授权决策；其他 principal 无对应 policy 时拒绝，不应在 fixture 里用放行 stub 替代正式服务。[Gateway 入口](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/gateway/src/index.ts#L209)、[调用准入](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/gateway/src/index.ts#L774)、[RemoteAccess 实现](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/api/remote-access/src/index.ts#L139)、[Connection Peer](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/connection/src/rpc-host.ts#L70)

## 存储、归档与资源边界

| 边界 | 固定版本源码结果 | 兼容性影响 |
| --- | --- | --- |
| Session 格式 | `SESSION_FORMAT_VERSION` 仍为 `4`；format-catalog 编译实现逐字节相同。 | 不能因此跳过新 SDK 准入与资源身份复核。 |
| JSONL 物理资源 | generation、文件命名、编码、writer lease 源码未变；仍使用配置选定的 raw/zstd。新增 listing 并发上限和 `formatStatus`。 | 需要验证并发 listing、格式状态及卸载；没有新增永久删除公开 API。 |
| Workspace domain | `workspaceDomainSpec` 仍 version `2`，记录与全局 schema 未变。 | 已有数据无需由插件改写归档状态。 |
| 原生 Archive | archive/unarchive、幂等返回、活动 waterfall 与 `stopActivity` 源码未变。 | 已归档幂等返回仍不能证明无活动；删除准备须独立检查。 |
| 工作区成员 | 新增 `missingSessionPaths` Set；`candidateMatches` 在 cwd 因 ENOENT 缺失时保留既有候选归属。 | metadata 清理须包括此新内存索引；不能仅删除旧 `headers/sessionPaths/invalidSessionPaths`。 |
| Projection cache | domain 仍 version `7`；cache spec 和主实现源码未变。 | 仍需复核脏写、retain、缓存文件身份与释放边界。 |
| Query | SQLite 主实现逐字节相同；Session query corpus 新增 `formatStatus` 传递。 | 新列表元数据不是删除授权；原先观察引用保护仍需保留。 |
| Agent 生命周期 | `AgentHandle.dispose()` 保留；AgentLoop 修复 teardown 为停止 driver、卸载 scope、排空并关闭 persistence handle、detach registry，失败聚合。 | 必须重跑 idle release、错误路径及 provider unload；不能只换 hash。 |

依据：[Session 格式](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/core/session/src/types.ts#L90)、[JSONL generations](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/session/session-persistence-jsonl/src/generation.ts)、[Workspace schema](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/workspace/workspace/src/spec.ts#L76)、[Archive 活动检查](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/workspace/workspace/src/index.ts#L344)、[缺失目录成员规则](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/workspace/workspace/src/index.ts#L176)、[cache schema](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/session/session-projection-cache/src/spec.ts#L100)、[query corpus](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/session-query/session-query/src/corpus.ts#L64)、[AgentLoop teardown](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/core/agent-loop/src/index.ts#L539)。

新实验性 `appendPluginRecord`/`pluginRecordOf` 的状态记录保存在同一 Session 事件流中，携带 `ignorable: true`，resume/fork 随日志保留；这个接口没有引入独立的会话文件 owner。上游明确禁止仓库外第三方插件调用 writer，本插件不应采用。该结论不覆盖任意第三方插件自行维护的外部数据。[上游 Session 契约](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/core/session/README.md#write-experimental-plugin-records)

## npm 编译实现核对

以下为目标发布物的 `lib/index.js` SHA-256。除 Cordis `4.0.5` 外，各行均为 `0.2.1-rc.1`。这些值用于来源核对，不能单独授予删除资格；运行时还应核对实际解析到的 package version、相关其他文件及具体服务实例。[npm registry](https://registry.npmjs.org/)

| 包（`@deepseek-ai/` 前缀） | SHA-256 |
| --- | --- |
| `cordis` | `6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e` |
| `dsh-session` | `2f5dd07cb5c744a29abbb8003a8a4cefd9e582c6e2538074ca299a0ddd02a3bf` |
| `dsh-session-persistence` | `cc0b6d3a224133af611b428d5a49020e300f86c3b4ba28037aeb219029bde3eb` |
| `dsh-session-persistence-jsonl` | `973dd78679b2661d6f492343bc22b124ae958aa597d3b36c698a2c650f909984` |
| `dsh-session-format-catalog` | `836bbb772ab505c299f1a4a246164c50c7c08b67ab0d17f1251d7ea2cd8c1818` |
| `dsh-storage-domain` | `a54f7664d2f64fe04a08c7058ca5bff4fc69ed6a0d30c2bc11561b620698ef16` |
| `dsh-storage-json` | `0a6b75d5569db3379edd93e863570170e1f4121b6c9fabd856f5b476cffe8df4` |
| `dsh-workspace` | `931ca0cb10c5102066c7723690a887f0e6e8e7ab0ffdee1a782686745b0b934f` |
| `dsh-session-query` | `76ce2944e561c12f48b5e240d68cafe54ce6d667b1d20722e6939ed834489939` |
| `dsh-session-query-sqlite` | `dbecf83320e10d93d735b3d01384ab817a0b90102ccecb0a22c013c71dfe70a0` |
| `dsh-session-projection-cache` | `faf307dce5db2fb7ff58b4c7d9e544fc7cad5de2f270a89326a8d7bb2bda9c80` |
| `dsh-api-session-controller` | `a9801acb577b03053c5d5a3191ff555c5f1d791d0acddec113bea4511e33b386` |
| `dsh-agent` | `7b59cf82c2784c25bdce4e3e24e5e5303b02b9f1003efacf50255492d17baf8b` |
| `dsh-agent-loop` | `cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033` |

`lib/types/index.js` 额外核对值：`dsh-session` 为 `59cced30c7ee65813c62f4858c2fc15c8c636df96507b60c15543468178b72f2`；format-catalog 为 `c7d797760bf2b9bc654751f2f8cb0b8a6b98998c8d9c1e41323c71a4d5f316f2`；workspace 为 `ed69989d8286598fddb3a40030723810a1238968e91ccfec05fc84657bb5ec74`；API Session controller 为 `616ced16623b7448afa908ff65093eb6ef2a478d32e5ef9bc22634bfa9f80472`。

JSONL 内部类未导出。对正式 npm 包进行隔离挂载后，原始服务实例的 `constructor.name` 为 `JsonlSessionPersistence`，`constructor.toString()` 长度为 `48860`，SHA-256 为 `bb0e12b14bd21adec58c51934f00014e482380102f09aa5e935536c57c0d6e1e`。必须先取 `provider[Symbol.for('cordis.original')] ?? provider`：Cordis caller shadow 的 constructor 是代理函数，其 `toString()` 仅为 `function () { [native code] }`，不能用于源码身份核对。此构造器观测仅在隔离临时目录挂载和卸载服务，没有执行会话操作；仍须结合上表 package version/index hash 及实例结构。[JSONL 发布物](https://registry.npmjs.org/@deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.2.1-rc.1.tgz)

## 客户端与发布边界

插件使用的原生 Button/Input/Checkbox 等控件仍有公开导出；`main`、`sidebar.panellist`、`shell.overlay` 槽位仍存在。Workspace 的新会话导航和 toast 有扩展，不能据此推断本插件完整界面已通过。Client modules 新增跨 Host release 的页面更新暂停策略；重连/重载仍须验证本插件不会重发删除。[原生控件导出](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/ui-primitives/src/index.ts)、[布局槽位](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/ui-layout/src/client/index.ts)、[Client release 策略](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/modules/src/client/entries.ts)

部分 SDK `/client`（包括 Connection、Gateway）新增 conditional exports：`node` 指向可直接 import 的 `client.node.js` ESM，`browser`/`default` 指向 `client.browser.js` lazy factory。因此在 Node 下 `require.resolve('<package>/client')` 返回 ESM 不能证明浏览器格式变更；将它交给 classic-script VM 执行会失败。浏览器的 `window.__ModuleLoader__.load({ id, factory })` 协议继续存在，本插件当前 lazy factory 构建不因此失效。Node 逻辑 fixture 可直接 import 公开 `/client`；需要验证真实浏览器 ModuleSystem 的 fixture 应按 Host 规则读取 manifest 的字符串 export 或一层对象的 `default`，使用已发布的浏览器 artifact，不能重新编译它或以 Node ESM 替代浏览器证据。Host ClientModuleRegistry 的 `clientExportOf` 正是读取该 `default`，不使用 Node 的 `require.resolve('/client')` 结果。[官方条件构建](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/tsdown.client.ts#L218)、[Node ESM 构建](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/tsdown.client.ts#L486)、[Host 浏览器 export 选择](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/modules/src/index.ts#L195)、[lazy factory 协议](https://github.com/deepseek-ai/deepseek-harness/blob/1600d8a1e140dcde43a1a0941940a0480712c011/packages/client/modules/src/client/manifest.ts#L9)

2026-10-17 重新核对 npm 官方规则：trusted publishing 要求 npm CLI 至少 `11.5.1`、Node 至少 `22.14.0`、受支持的托管 runner 与 `id-token: write`；publisher 的仓库、workflow 文件及允许操作须匹配，新的配置须在两天内首次成功发布。GitHub Actions 的公开包及公开仓库可自动生成 provenance。本项目现有 workflow 采用该路线，实际发布结果仍须检查 CI 与 registry，不能从配置推断成功。[npm 官方 trusted publishing 规则](https://docs.npmjs.com/trusted-publishers/)
