# DSH 0.2.1-rc.5 源码与发布物审阅

日期：2026-10-30。基线为已发布插件 `0.2.6` / DSH `0.2.1-rc.3`，目标精确固定为 `0.2.1-rc.5`。本文记录一手源码与发布物事实；正式构建的运行结果和资格见[rc.5 验证](../verification/dsh-0.2.1-rc5.md)。本轮不发布插件。

## 来源与身份

- 官方 [Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.1-rc.5) 于 `2026-10-30T02:12:26Z` 发布，tag 指向 `b830ec950faba0a46dda564be3e2d854afed94f1`。[rc.3 → rc.5 源码比较](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.1-rc.3...dsh-v0.2.1-rc.5)包含 13 个提交。
- [npm registry](https://registry.npmjs.org/@deepseek-ai%2Fdsh) 的精确版本发布时间为 `2026-10-29T14:15:23.355Z`；[DSH tarball](https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-0.2.1-rc.5.tgz) SHA-256 为 `60987566f19e0ded1f7918c00a65c19c56ea25f5977ee0bfd5697c5c113ec4e1`，SHA-512 与 registry integrity 一致。[JSONL tarball](https://registry.npmjs.org/@deepseek-ai/dsh-session-persistence-jsonl/-/dsh-session-persistence-jsonl-0.2.1-rc.5.tgz) SHA-256 为 `0df5ce77626ee7f337cbc41675bdc3a87c0e664662880c5ead9b94d24a1a28ad`。
- 重新下载并核对 33 个相关包的 rc.3/rc.5 发布物，共 66 个 tarball，逐包验证 SHA-512，逐文件核对 frozen install 的实际内容，不运行安装脚本。范围包含全部受保护 Host 实现及所有有内容变化的 DSH 包。
- 比较实际安装的 299 个 DSH 包，包集合没有增删。锁文件均有 800 个 package 条目；第三方版本、元数据和 integrity 相同。归一化 DSH 版本及不透明 peer-context hash 后，importer 与 dependency snapshot 相同。release-age 例外只替换精确官方 DSH 版本。
- npm 没有 `gitHead`；客户端内嵌构建标识 `d4db512` 在公开仓库 API 无法解析。不能把该标识等同于已核实的 tag 提交。编译实现的审阅绑定 npm integrity、tarball 和逐文件摘要，公开 tag 源码用于核对变化含义。

## Host 生命周期与持久化协议

生产指纹锁定的 18 个实现文件（17 个 DSH 文件及未升级的 Cordis `4.0.5` 文件）全部与 rc.3 逐字节一致。Session/format、persistence/JSONL、storage domain/JSON、Workspace、query/cache/SQLite、API Session controller、Agent/AgentLoop 的既有 SHA-256 无需替换。

沿这些实现复核后，未发现本插件所依赖调用路径的变化：

- 原生 Archive 集合及宿主活动检查保持；没有新增公共永久删除接口。
- JSONL generation、writer/openHandles、内核 lease、资源枚举和释放顺序保持。只读观察仍不产生写所有权或删除授权。
- query prepared observation 的 refs/retain/dispose、cache eviction，以及 history follower 的 finally 释放与后续 promotion/resume 保持。目标占用和未知状态保护继续执行。
- AgentHandle 与 idle release 的实现相同；无 Agent、旧 follower 和无关会话的定点释放规则仍由插件现有回归验证。

因此宿主、参与包及 JSONL adapter 的精确版本检查可更新为 rc.5，保留全部实现摘要、私有类身份检查、运行时/平台/文件系统/存储范围及 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md) 的 schema-1 durable 身份。历史 hostVersion、fingerprint、queryProvider 不随 SDK 版本重写。正式验收另发现并修复插件已有的可选元数据服务启动快照竞态，过程及回归归[验证报告](../verification/dsh-0.2.1-rc5.md)。源码相同不替代独立正式构建验收。

## 实际内容变化与插件影响

| 包/路径 | rc.3 → rc.5 变化 | 本插件影响 |
| --- | --- | --- |
| `dsh-client-ui-chat` | 展示前移除前导 signature；Body Slot 同时提供 `rawText` 与展示用 `text`，活动摘要沿用同一展示处理。 | 本插件不注册 reasoning Body/Content Slot；原生历史仍由宿主展示。类型与真实历史 GUI 单独验证。 |
| `dsh-cordis-client-runner` | Slot 目录同步上述 props、注释和源码行号。 | 不改变本插件的 Sidebar/main 注册。 |
| `dsh-experimental-client-ui-cot-translation` | 文档注释同步展示文本含义。 | 不涉及归档、持久化或删除。 |
| `dsh-client-ui-conversation` | 长标签才显示 tooltip；More 菜单使用固定文案。 | 入口 id、view 注册和 Remote 契约保持；双语窄屏/键盘 GUI 验证实际行为。 |
| `dsh-client-modules` / `dsh-client-ui-sidebar` | 构建标识、版本展示。 | 不改变插件加载与生产资源身份。 |
| `dsh-mcp-client` | 没有 resources capability 时直接返回空列表，避免 SDK debug 污染 ACP stdout。 | 不涉及删除调用链。 |
| `dsh-llm-deepseek-account` | 模型列表 info 日志从 stdout 改为 stderr。 | 不涉及删除调用链；不据此声称账号/模型推理验收。 |
| `dsh-mcp-resources` | 说明文档同步空列表行为。 | 实现不变。 |

思考展示变化的一手实现见 [ReasoningRow](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-chat/src/client/chat/ReasoningRow.tsx)、[reasoningText](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-chat/src/client/reasoning-text.ts) 与 [Slot 契约](https://github.com/deepseek-ai/deepseek-harness/blob/b830ec950faba0a46dda564be3e2d854afed94f1/packages/client/ui-chat/src/client/contract/slots.ts)。

## 官方 macOS ARM64 Desktop

重新读取[官方 nightly feed](https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml)，下载[精确 rc.5 ZIP](https://download.deepseek.com/dsh-desk/bin/mac-arm64/deepseek-harness-0.2.1-rc.5-mac-arm64.zip)，大小 `347767892` 字节；SHA-256 为 `3ca30beaa2b90dc401fae0860e2ba53b44f89141396153a24bba054f29670ebd`，SHA-512 与 feed 一致。归档路径及解压后 symlink 均限制在独立目录内；`codesign --verify --deep --strict` 通过，bundle 为 `com.deepseek.dsh`，Team ID 为 `NAN929V4UM`。没有替换或启动用户已安装应用及真实 profile。

候选 CI 已记录精确 Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1`、ABI `149`、SQLite `3.53.4`、Zstd `1.6.0` 与 Host protocol `4`；本轮正式源码另行在同一独立官方载体完成验收，不将 candidate 标记转换成生产证据。

公开发布物与原始比较保存在忽略目录 `.local/rc5-review/`：`published-integrity.json`、`graph.json`、`diffs/`、`lock-review.json`、`sdk-source-review.json`、`desktop-artifact.json`。这些证据仅包含公开发布物与独立测试数据。
