# DSH 0.2.1-rc.2 桌面运行时与 ASAR 调研

日期：2026-10-18。对象为本机 `/Applications/DeepSeek Harness.app` 的 DSH `0.2.1-rc.2`，研究范围限定 macOS ARM64、Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1` 与拟独立验收的 APFS 组合。本文只读取安装包、运行时和 SDK 元数据，并进行不激活 Host/Session 的模块加载探针；没有访问真实 `DSH_HOME` 或会话。正式删除资格由独立运行验证决定，不扩展到普通 Node `24.21.0`、Intel、Windows 或其他 Electron 版本。

## 结论与版本来源

插件 `0.2.2` 的运行时准入只接受 Node `24.18.1` / libuv `1.52.1`；该桌面包实际使用 Node `24.21.0`，会在读取 SDK fingerprint 前被拒绝。因此 `unsupported` 的首个原因是遗漏官方桌面运行时组合，不能由包名同为 DSH rc.2 推断已支持。[0.2.2 owner 准入](https://github.com/takboo/dsh-session-bin/blob/20b42ea8a623ba9835ab2b60ab0a57a13359f116/src/host/native-retirement-owner.ts#L102)、[0.2.2 平台资格](https://github.com/takboo/dsh-session-bin/blob/20b42ea8a623ba9835ab2b60ab0a57a13359f116/src/host/platform-files.ts#L12)

Electron 官方 `44.7.0` 发布记录明确列出 Node `24.21.0`、Chromium `152.0.7977.130` 和 V8 `15.2.124.28`。DSH rc.2 的固定上游提交 `687f282e8625c6b8d11ff58211a90524be2e4317` 声明 Electron `^44.7.0`、pnpm `11.28.5`；prepare-runtime 会实际运行目标 Electron 的 Node 模式，把 `process.versions.node` 写入运行时元数据。这与本机安装结果一致，不是把桌面 Node 版本从 CLI 环境猜出来。[Electron 44.7.0](https://releases.electronjs.org/release/v44.7.0)、[Node 24.21.0 官方发布](https://nodejs.org/en/blog/release/v24.21.0)、[DSH Desktop manifest](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/package.json#L65)、[目标 Electron 版本探测](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/scripts/prepare-runtime.ts#L23)

本机 `Info.plist` 的产品版本为 `0.2.1-rc.2`；`app.asar/dsh/desktop-runtime.json` 记录同一产品版本、Host protocol `4`、Node `24.21.0`、pnpm `11.28.5`、`darwin/arm64`。实际执行应用二进制的 `ELECTRON_RUN_AS_NODE=1` 进程与这些值相符。系统为 macOS `15.7.9`（`24G830`），工作区探针卷的 `statfs.type` 为 `0x1a`。安装包观测完整保存在[只读审计证据](../../.local/debug/desktop-research-audit.json)；这些值记录本机样本，不是其他安装包的承诺。

## SDK、传递依赖与资源契约

从实际 ASAR 内解析到的 18 个受审计文件全部与 rc.2 npm 基线的版本及 SHA-256 一致，包含 `native-retirement-sdk` 主表和附加 Agent/AgentLoop 检查。完整逐文件路径、版本与 hash 位于上述审计 JSON；主表 hash 另见 [rc.2 调研](dsh-0.2.1-rc2.md)。附加生命周期实现为：

| 实际安装包 | 版本 | `lib/index.js` SHA-256 |
| --- | --- | --- |
| `@deepseek-ai/dsh-agent` | `0.2.1-rc.2` | `7b59cf82c2784c25bdce4e3e24e5e5303b02b9f1003efacf50255492d17baf8b` |
| `@deepseek-ai/dsh-agent-loop` | `0.2.1-rc.2` | `cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033` |

删除路径所用依赖的安装版本也与现有 npm 组合一致：Cordis `4.0.5`、Loader `1.0.6`、Schemastery `3.18.5`、Zod `4.4.3`、p-limit `7.3.3`、node-addon-system 及其 Darwin ARM64 包 `0.1.2`、node-addon-require-builtin 及其 Darwin ARM64 包 `0.1.9`、Koffi 及其 Darwin ARM64 包 `3.1.1`。实际 node-addon-system `lib/flock.js` SHA-256 为 `e42af00c298d56322c073bf7cc66485096028318ab645a2e69dc2aa7481ba646`，与工作区依赖逐字节一致。上游 flock 使用 Node-API 8 构建；这解释其跨 Electron ABI 加载的技术基础，但不能替代实际锁行为验证。[稳定 Node-API flock 构建](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/native/system/scripts/build.ts#L57)、[flock 契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/native/system/docs/flock-contract.md)

没有发现桌面包改变 Session 格式、JSONL 资源、Workspace/cache schema、AgentHandle 语义或持久化参与方的源码证据；这支持保持既有 schema-1 durable contract 身份，并独立增加实际运行时资格。它不允许跳过源码检查，也不应重写旧 manifest、grant 或回执。协议身份与实际运行时的区别仍遵循 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md)。

## Electron 与原生 ASAR 加载

Electron 对 `fs`、`require` 等接口提供 ASAR 虚拟目录支持；归档只读，`dlopen` 等需要物理文件的操作具有额外解包要求。DSH 将生产 JS 树放在 `app.asar/dsh`，把原生库放在相邻 `app.asar.unpacked`，并在打包后运行目标 Electron 的 payload/Host smoke。不能把普通 Node 不认识 ASAR 的结果解释为 SDK 缺失。[Electron ASAR 规则](https://www.electronjs.org/docs/latest/tutorial/asar-archives)、[DSH 桌面打包规则](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/packaging/README.md#desktop-runtime-preparation)、[builder 的 ASAR 与解包配置](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/scripts/electron-builder-config.mjs#L120)

本机以下 ASAR 虚拟文件与对应的 `app.asar.unpacked` 物理文件逐字节一致：

| 原生文件（相对 `dsh/node_modules/`） | SHA-256 |
| --- | --- |
| `@deepseek-ai/node-addon-system-darwin-arm64/bin/system.node` | `e25056346e033991ed14a01f0804851f2b7a33b2c8c0b2d8de58eb3159bbb390` |
| `node-addon-require-builtin-darwin-arm64/prebuilt/darwin-arm64-napi-v9.node` | `556d255d1e262b7583626ea01b835fc3cc59a731a79f852362003eab4d12ae37` |
| `@koromix/koffi-darwin-arm64/darwin_arm64/koffi.node` | `04f24b3bd940680e6b36ac6e65114f619ea22cb62579f0ba16e1025943fcc027` |

这些是本机已打包原生文件的来源观测，不据此宣称所有平台二进制相同。Electron 的传统 addon ABI 与独立 Node 不同，Node 版本同名也不保证 native module 兼容。[Electron 原生模块说明](https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules)

## 隔离验证的最小 bootstrap

上游 Host 和 smoke 的正式方式是应用二进制加 `ELECTRON_RUN_AS_NODE=1`、`--expose-internals`，再以 `createRequire(<app.asar/dsh/package.json>)` 解析实际 runtime 包；没有要求调用另一个全局 SDK bootstrap。原生缓存使用私有 `NARB_NATIVE_CACHE_DIR`；完整 Host smoke 另建临时 `DSH_HOME` 和 profile。不要把上游完整 smoke 直接指向真实 profile。[Host 启动](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/host-process.ts#L187)、[Node 环境](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/src/node-environment.ts)、[私有 native cache smoke](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/scripts/smoke-prepared-runtime.ts#L23)、[临时 Host smoke](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/apps/desktop/scripts/smoke-runtime.ts#L29)

仓库 fixture 若要保持已有相对入口、同时把所有 `@deepseek-ai/` 导入统一到安装包，可在 `--import` preload 中注册同步 `module.registerHooks`：对该前缀调用 `next(specifier, { ...context, parentURL: runtimePackageJsonUrl })`，其他请求沿用原解析。应在 fixture 模块加载前安装 hook；不要在 hook 中直接递归调用未设防的 `createRequire.resolve`。本地[最小探针](../../.local/debug/desktop-bootstrap-probe.mjs)已确认实际 JSONL URL 位于 ASAR，Cordis、SessionPersistence、JSONL 插件、内部 ESM loader、原生 `system.node` 的 `tryLock` 导出均可加载；Koffi 调用 `getpid` 与进程 PID 一致。[探针输出](../../.local/debug/desktop-bootstrap-probe.log)只证明加载与符号调用，未创建 Context、Host 或 Session，未执行锁竞争或删除。

## 独立验收边界

同一 libuv 不能概括两个运行时的全部行为。实际桌面值与固定 CLI Node 的差异如下，详见[运行时比较证据](../../.local/debug/desktop-runtime-comparison.json)：

| 项目 | 已验收的独立 Node | 本机 Electron Node |
| --- | --- | --- |
| Node | `24.18.1` | `24.21.0` |
| Electron | 无 | `44.7.0` |
| 模块 ABI | `137` | `149` |
| Node-API | `10` | `10` |
| libuv | `1.52.1` | `1.52.1` |
| SQLite | `3.53.1` | `3.53.4` |
| Zstandard | `1.5.7` | `1.6.0` |
| V8 | `13.6.233.17-node.50` | `15.2.124.28-electron.0` |

因此新组合应在真实 Electron 加实际 ASAR SDK 下重新验证 raw/zstd、已启用 SQLite/cache、精确 idle release、原生活动拒绝、锁竞争和进程死亡恢复。只扩展本机独立通过的 `darwin/arm64 + Electron 44.7.0 + Node 24.21.0 + libuv 1.52.1 + APFS`，保留其他组合各自原有资格；普通 Node 24.21、其他架构或未来桌面版本均不能由本文自动获准。
