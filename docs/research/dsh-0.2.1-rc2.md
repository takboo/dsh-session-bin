# DSH 0.2.1-rc.2 接口与资源生命周期调研

日期：2026-10-17。比较基线为插件 `0.2.1` 已支持的 DSH `0.2.1-rc.1`，目标为用户指定的 `0.2.1-rc.2`。本文记录官方源码与 npm 发布物的差异；源码相同不等于新宿主组合已经取得永久删除生产资格。运行结果另见[兼容性验证](../verification/dsh-0.2.1-rc2.md)；上一轮接口断点见 [rc.1 调研](dsh-0.2.1-rc1.md)。

## 版本和来源

- npm 准确 semver 为 `0.2.1-rc.2`，`@deepseek-ai/dsh` 于 `2026-10-17T08:36:31.655Z` 发布；调研时 `next` 指向该版本，`latest` 仍为 `0.2.0-rc.2`。验收固定完整版本，不以 dist-tag 替代。[npm registry 元数据](https://registry.npmjs.org/@deepseek-ai%2Fdsh)
- 上游 Release 为 `dsh-v0.2.1-rc.2`，发布时间 `2026-10-17T08:16:33Z`；tag 指向 `687f282e8625c6b8d11ff58211a90524be2e4317`。基线 rc.1 tag 指向 `1600d8a1e140dcde43a1a0941940a0480712c011`。发布说明的新增内容为 DeepSeek 模型适配及 Search/Fetch API。[目标 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.2)、[固定目标源码](https://github.com/deepseek-ai/deepseek-harness/tree/687f282e8625c6b8d11ff58211a90524be2e4317)、[完整源码比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.1...dsh-v0.2.1-rc.2)
- 从 registry 指定地址下载 npm tarball，没有执行其安装脚本。DSH tarball SHA-256 为 `40e3d025c0240c4316ff42dee9bedc7709c0fb38aea10543b47076ed2af52e1d`；JSONL tarball 为 `ad5213bfc56650b8361bad5e2d09a72b0d843cd8101cd1328044a1c4abab3330`。源码快照、逐包 registry dist integrity、tarball、逐文件 SHA-256 和比较结果保存在忽略的 `.local/research-rc2/`。[DSH tarball](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.2.tgz)、[JSONL tarball](https://registry.npmjs.org/@deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.2.1-rc.2.tgz)

## 接口与准入结论

**相对已适配 rc.1 的插件，未发现新的宿主业务接口断点。** `native-retirement-sdk.ts` 审计的全部编译实现及 `lib/types/index.js`，连同附加检查的 Agent/AgentLoop，实现文件均与 rc.1 逐字节相同。JSONL 原始构造器也相同。因此当前源码证据要求更新精确版本声明、lockfile 和 runtime version gates，再进行 rc.2 独立验收；没有证据要求再次修改删除业务流程。既有 rc.1 精确版本检查会拒绝 rc.2，这是原有准入策略，不应通过放宽为任意 semver 范围绕过。[Session 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/index.ts)、[JSONL 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/index.ts)、[API Session 源码](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/index.ts)

rc.1 已修复的契约继续适用：JSONL 使用命名插件入口；API 激活捕获覆盖 `resumeObserved`、`claim`、`createAgent`；`summarizeCold` 接收 `{ header, formatStatus }`；Gateway 依赖 `remoteAccess`，调用显式使用 Peer；Connection 使用 `browserPeer`。对应源码在 rc.1→rc.2 比较中没有变化，不能回退旧签名或旧 fixture。[API 激活调用链](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/agent.ts#L424)、[冷摘要](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/session-controller/src/list.ts#L167)、[Gateway 注入](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/api/gateway/src/index.ts#L209)、[Connection](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/connection/src/rpc-host.ts#L70)

## 存储、归档与 durable 身份

| 边界 | 与 rc.1 的比较 | 兼容性含义 |
| --- | --- | --- |
| Session 格式 | 仍 `SESSION_FORMAT_VERSION = 4`；Session 与格式目录实现相同。 | 没有新的格式转换或文件代次。 |
| JSONL | 主实现、generation、lease、storage、tracker、迁移准备和 verifier 源码相同。 | 资源清单、writer 命名空间、句柄排空和 migration 保护保持。 |
| Workspace | schema 仍 version `2`；活动检查、Archive/unarchive、`missingSessionPaths` 索引和成员规则相同。 | 继续清理目标索引，保留原生活动保护。 |
| Projection cache | schema 仍 version `7`；实现、记录与目录布局相同。 | 没有新增 cache 资源或恢复源。 |
| Query/SQLite | 主实现、观察引用、corpus 与派生索引实现相同。 | 原先 retain、重建与收敛边界保持。 |
| Agent/API Session | AgentHandle、AgentLoop teardown、API create/resume/list 实现相同。 | idle release 与未知结果保护保持，仍需实际回归。 |

依据：[格式版本](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/session/src/types.ts#L90)、[JSONL tracker](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/storage.ts)、[JSONL generations](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/src/generation.ts)、[Workspace schema](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/workspace/workspace/src/spec.ts#L76)、[cache schema](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-projection-cache/src/spec.ts#L100)、[Query](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session-query/session-query/src/index.ts)、[AgentLoop teardown](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/core/agent-loop/src/index.ts#L539)。

**源码证据支持继续保留 schema-1 durable resource/journal 身份。** 没有新增由删除 adapter 负责的持久化参与方，资源 revision、冻结 manifest、授权 grant 和回执语义均未改变；运行时的 rc.2 精确准入仍须独立检查。历史 `legacyDurableHostContract = '0.2.0-rc.2'`、fingerprint `2618a33decce99fe8ae893245236273d10ac5536bb9dd582dddd115ef27069f3` 和 schema-1 query provider 标识是既有协议身份，不能显示成当前实际宿主版本。保留身份也不授予跨进程自动重发删除或跨版本热接管。prepared、done、pending/部分擦除的跨版本运行证据由验证报告记录。[已选定的兼容协议决策](../decisions/0011-runtime-and-durable-retirement-identity.md)

## npm 编译实现核对

下表为 rc.2 发布物的 `lib/index.js` SHA-256；所有值与 rc.1 相同。Cordis 保持 `4.0.5`，其余各行版本为 `0.2.1-rc.2`。来源为对应包的 registry tarball，而非工作区重新构建物。[npm registry](https://registry.npmjs.org/)

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

额外 `lib/types/index.js`：Session 为 `59cced30c7ee65813c62f4858c2fc15c8c636df96507b60c15543468178b72f2`，格式目录为 `c7d797760bf2b9bc654751f2f8cb0b8a6b98998c8d9c1e41323c71a4d5f316f2`，Workspace 为 `ed69989d8286598fddb3a40030723810a1238968e91ccfec05fc84657bb5ec74`，API Session controller 为 `616ced16623b7448afa908ff65093eb6ef2a478d32e5ef9bc22634bfa9f80472`，均与基线相同。

对下载的官方 rc.2 JSONL 发布物进行隔离挂载，使用 Node `24.18.1`、Cordis `4.0.5` 和已安装的 rc.2 persistence 依赖，原始 `JsonlSessionPersistence` 构造器 `toString()` 长度仍为 `48860`，SHA-256 仍为 `bb0e12b14bd21adec58c51934f00014e482380102f09aa5e935536c57c0d6e1e`。先通过 `Symbol.for('cordis.original')` 取原始实例；Cordis shadow constructor 的 native-code 代理不能证明来源。该探针只挂载、观察和卸载服务，没有执行会话读写或删除，不能替代生命周期验收。本地观测为 `.local/research-rc2/constructor-evidence.json`。[JSONL 发布物](https://registry.npmjs.org/@deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.2.1-rc.2.tgz)

## 客户端、传递依赖与发布边界

直接使用的 Client 控件、layout、slots、Workspace、Gateway、Connection、RemoteAccess、Typert 和浏览器/Node 条件导出保持不变；浏览器仍使用 lazy factory。两个编译产物的变化仅为构建身份：ClientModules Host 的 embedded commit 从 `ed75efe` 改为 `332895e`；Sidebar 的 `localBuildVersion` 文本从 `0.2.1-rc.1-ed75efe` 改为 `0.2.1-rc.2-332895e`。Sidebar 没有其他代码差异，也不是新模型标签插件的实现变化。新旧页面仍按既有 release-change 规则处理；compiled commit 是包内构建身份，不应冒充上游 Release tag commit。[ClientModules release 身份](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/modules/src/index.ts)、[release-change 策略](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/modules/src/client/entries.ts)、[Sidebar 版本徽章](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-sidebar/src/client/index.ts)

上述两个变化文件的 rc.2 SHA-256 分别为：ClientModules `lib/index.js`：`d2d89461e1e7f15d6e24cd8ac3faaa2b931e066d5b5300f3c38aea29def38bcf`；Sidebar `lib/client.js`：`4d4535b9ac9160e13067b1f8a8510d158da2aaf6a15191b418a5956261ff9b3e`。[ClientModules tarball](https://registry.npmjs.org/@deepseek-ai/dsh-client-modules/-/dsh-client-modules-0.2.1-rc.2.tgz)、[Sidebar tarball](https://registry.npmjs.org/@deepseek-ai/dsh-client-ui-sidebar/-/dsh-client-ui-sidebar-0.2.1-rc.2.tgz)

一手 manifest 比较中，既有 SDK 依赖除 rc.1→rc.2 版本替换外未变：Cordis `~4.0.5`、Loader `~1.0.6`、Schemastery `~3.18.5`；JSONL 的原生/并发依赖仍为 node-addon-system `~0.1.2`、Koffi `3.1.1`、p-limit `7.3.3`。官方 base 新增 `dsh-web-deepseek-api`，web-app 新增 `dsh-client-ui-deepseek-model-label-1017`；前者提供搜索/抓取服务并读取当前 Session 的问题文本，后者装饰模型 label slot。两者没有注册新的 Session 持久化 owner、会话文件或删除能力。[CLI manifest](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/cli/package.json)、[JSONL manifest](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/session/session-persistence-jsonl/package.json)、[base 组合](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/bundle/base/cordis.patch.yml#L475)、[搜索/抓取 provider](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/web/web-deepseek-api/src/index.ts)、[模型标签](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-deepseek-model-label-1017/src/client/index.ts)

重新核对 npm 官方 trusted publishing：仍要求受支持托管 runner、`id-token: write`、npm CLI 至少 `11.5.1`、Node 至少 `22.14.0`，并匹配 publisher 的仓库、workflow 和允许操作；公开 GitHub 仓库的公开包可自动生成 provenance。本轮研究不执行发布；最终以 CI 及 registry 的实际记录为准。[npm 官方规则](https://docs.npmjs.com/trusted-publishers/)
