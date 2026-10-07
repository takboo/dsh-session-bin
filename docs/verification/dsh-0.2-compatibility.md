# DSH 0.2.0-rc.2 兼容性运行验证

日期：2026-10-06。状态：存储、归档、JSONL、Host 与 Client 加载验证通过，范围和未覆盖能力如下。

## 本轮问题与结论

验证当前版本能否通过公开 npm SDK 加载独立插件，并使用原生归档和插件自有元数据建立可恢复的回收站。

已验证：插件自有记录可通过 `storageDomain` 和 JSON 后端持久化；原生归档/恢复保留工作区成员与顺序；JSONL 的普通及 Zstandard 编码均支持读写往返和跨进程写入者排除。原生永久删除仍缺少公开能力；本轮没有实现或执行永久删除。

探针源码、工具配置和依赖锁定的捕获提交为 `258be2d`，作为可复现的实验材料。该工程不作为产品发布包；正式接口与实现规则见[Host 生命周期](../host-lifecycle.md)和[客户端接口](../client-interface.md)。

## 环境与来源

- Node `24.18.1`、pnpm `11.7.0`、GitHub CLI `2.102.0` 通过 [mise.toml](../../mise.toml) 管理。本轮将工具、状态、缓存和 pnpm store 全部置于忽略的 `.local/` 内，避免依赖全局工具版本。
- 操作系统为 macOS ARM64；本轮未验证 Windows 或 Linux。
- 使用 npm 的 DSH `0.2.0-rc.2`、Cordis `4.0.4`、Loader `1.0.5`、React `18.2.0` 与 Zod `4.4.3`。依赖安装与一次 frozen-lockfile 安装通过，安装时禁用 lifecycle scripts。
- `storage-domain`、`storage-json`、`workspace`、`session-persistence-jsonl`、`client-modules` 五个 npm Implementation 的 `lib/index.js` SHA-256 与本机安装归档中的对应文件逐字节一致。测试直接导入 npm 公共入口；不导入 `.local/dsh-runtime` 的源码快照。
- 所有会话、目录、日志、无效数据和 tarball 位于 `.local/compatibility/` 的独立随机目录，保留供检查。当前 Web GUI 和真实用户会话没有被修改。

## 验证范围

| 验证 | 已执行行为 | 结论与范围 |
| --- | --- | --- |
| 元数据持久化 | 写入 Bin 条目，完整关闭并重新建立两轮 Context | 记录、版本、删除及恢复状态可重新读取；确认的是已确认写入后的重开，不是断电或故障注入恢复。 |
| 写入排序 | 32 次同记录 revision 更新与 12 次独立 put 并发执行 | 单进程 domain 串行化、变更事件顺序、文件与内存结果一致。JSON 后端没有跨进程写锁保证。 |
| 归档与恢复 | quiet archive、repeat、unarchive、repeat，检查工作区顺序和 pin 集合 | 保留成员及原位置；归档清除目标 pin；恢复不重新置顶。 |
| 回收站所有权 | 单独的原生归档及 wasArchived 记录 | 独立归档不进入 Bin；恢复原先已归档的对象保留其原生归档。 |
| 活动拒绝 | turn、subagent、job、schedule 单独和组合报告 | 通过真实 Cordis waterfall 使原生 Registry 在写入/停止之前拒绝；活动提供方为 fixture，未启动实际 workers。 |
| 已归档请求 | 给已归档对象设置活动后再次 archive，包括 stopActivity | 原生幂等返回跳过活动检查、写入和 stop 请求；返回成功不是静止证明。 |
| 不存在的会话 | missing archive/pin/unarchive | 前两者拒绝；unarchive 不检查存在性且不写入，不能用它证明日志可恢复。 |
| JSONL 持久化 | none 与 zstd 两种编码，两个真实事件的 append/flush/read/list/stat/reopen | 实际日志内容往返一致，读句柄拒绝写入；stat 的 eventCount 为可选，codec 将顶层缺省 delegationDepth 规范化为 0。 |
| JSONL 写入者 | 同实例、第二 Context、独立 Node 子进程争用 writer | 持有期间第二写入者被拒绝，close 后新进程能取得写入权；read 可观察已刷新的记录。 |
| Host 与 tarball | npm 离线打包、解包、公开 exports 解析、真实 Cordis Loader 的命名 inject/激活/卸载 | 打包内容闭合，Host apply/dispose 各一次；patch 为真实 insert 操作形状，完整 DSH CLI/profile 安装未覆盖。 |
| Client 加载 | 真实 ClientModuleSystem 的 prefetch/import、lazy factory、alias 与未声明请求 | 一次 bundle 请求和一次 factory 执行；别名复用同一 exports，缺少的请求明确失败。 |
| 槽位与共享身份 | 真实 SlotRegistry 等待声明、owner 卸载与重建、插件卸载；严格相等比较 | panel/sidebar ID 对应，声明重建后重新注册，插件卸载不复活；React、原生 Button、Cordis 和 slots 共享实例。owner 只提供文档约定的槽位，未运行完整 shell。 |

存储探针完成 13 组检查；JSONL 两种编码完成上述往返、只读、缺失和写入者场景。完整代码及 JSON 输出位于实验分支和本地 scratch 目录。

## 已复现的文档差异

`storageDomain.table.put` 在当前版本接受 schema-invalid 数据，文件和内存都发生变更；关闭后重新打开 domain 才返回 `DomainError('invalid-record')`，并包含 table/key。这与 README 的“每次写入 schema 验证”描述不同。

正式 Bin Implementation 每次写入前执行自己的 schema 校验并取快照，`update` 的变换也必须校验结果。probe 中故意绕过校验的记录只存在于单独的无效数据 domain，不污染有效 Bin 记录。原始调研的后续说明见[接口调研](../research/current-dsh-interfaces.md)。

## 实现选择

1. 使用原生 archive/unarchive，插件自有记录保留 `wasArchived`、操作身份、phase 和 schemaVersion。
2. 使用公开 domain 持久化元数据，在 Module 的写入入口校验，避免让无效值阻止重启。
3. 已归档对象单独复核活动；永久删除不能以 archive 成功或停止请求返回作为工作结束的证明。
4. intent、原生归档与条目提交属于独立持久化写入。本探针没有验证中途失败和重启对账，并发检查不证明跨进程事务或一致性；正式操作恢复的独立证据见[Host 验证](host-lifecycle.md)。
5. 保留经验证的 JSONL 写入者排除规则，当前不执行自行删除目录或锁文件的操作。

## 重跑

在隔离工作树或 checkout 中检出捕获提交 `258be2d`，然后从该 checkout 根目录运行：

```bash
export MISE_DATA_DIR="$PWD/.local/mise-data"
export MISE_STATE_DIR="$PWD/.local/mise-state"
export MISE_CACHE_DIR="$PWD/.local/mise-cache"
export MISE_TRUSTED_CONFIG_PATHS="$PWD"
mise install
mise exec -- pnpm install --frozen-lockfile --ignore-scripts \
  --store-dir "$PWD/.local/pnpm-store" --cache-dir "$PWD/.local/pnpm-cache"
mise run verify:compatibility
```

三个探针会自行创建随机 scratch 目录并输出位置，不连接开发者的 GUI。Client 探针使用本地 tarball、模拟 DOM 与真实 SDK Loader；本报告没有覆盖完整 profile/CLI 安装、真实 GUI、CSS、视觉或可访问性。

## 证据边界

本探针证明已确认持久化后的重开、原生归档语义、写入者排除与加载协议，不证明插件操作的中断恢复或完整界面行为。操作恢复见[Host 验证](host-lifecycle.md)，安装和界面见[客户端验证](client-interface.md)，各报告的基线与 fixture 范围保持独立。永久删除仍需要另行证明资源生命周期、提供方支持和故障行为，不能由 writer 排除结果自动推断。
