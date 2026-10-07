# Host 生命周期实现验证

验证对象：Host 生命周期，代码基线 `a151d56`。结果：17 项本地检查通过。目标 SDK：DSH 0.2.0-rc.2；平台：macOS ARM64。本报告的范围限该基线，完整客户端验收另见[客户端验证](client-interface.md)。

## 环境与命令

Node 24.18.1、pnpm 11.7.0、GitHub CLI 2.102.0 由 [mise.toml](../../mise.toml) 固定。构建依赖锁定 TypeScript 5.9.3、esbuild 0.25.10；运行依赖与 [package.json](../../package.json) 和 [pnpm-lock.yaml](../../pnpm-lock.yaml) 一致。

本轮依赖安装及一次 `pnpm install --frozen-lockfile --ignore-scripts` 均通过，未执行安装生命周期脚本。检查使用公共 npm SDK exports，不导入本地研究快照。通过 `mise run verify` 可按顺序复现类型检查、构建、全部行为测试与 tarball 验证。

## 实际检查

| 检查 | 执行内容 | 结果与证据范围 |
| --- | --- | --- |
| 类型与构建 | 严格 TypeScript 检查、声明构建、esbuild ESM 预编译 | 通过；Cordis 和官方 SDK 保持外部依赖，产物无 Client 声明。 |
| JSONL 往返 | 普通与 Zstandard 两种真实 JSONL 编码，移入、恢复、完整重开 | 通过；日志内容保持一致，工作区成员与顺序保留，冷检查不激活 Session；原生归档清除置顶，恢复不重新置顶。 |
| 所有权 | 普通原生归档、本插件条目、移入前已归档、未分组会话 | 通过；普通归档不进入目录，原先已归档对象恢复后仍归档；未分组条目无工作区身份。 |
| 活动与存在性 | turn、subagent、job、schedule 及组合；准备后活动变化、原生最终活动检查；缺失会话 | 通过；真实 Cordis waterfall 上 fixture 提供活动，执行拒绝且不发停止请求；缺失会话不因幂等原生行为获得条目。 |
| 幂等与并发 | 同一计划 12 次并发、两个不同计划竞争同一会话、旧移入回执在恢复和重开后重复、身份绑定不匹配 | 通过；历史结果不重放原生操作，不重复创建条目；不同参数使用同一身份被拒绝。 |
| 真实进程终止 | 移入与恢复各在 intent、原生变更、applied、条目变更和 done 的持久化事件处 SIGKILL | 10 个边界全部通过；未确认 intent 返回中断冲突，applied 后仅补元数据；重开日志与工作区相符，同一计划重复返回保存结果。 |
| 调用方校验与快照 | 无效条目、入队后修改写入对象、修改返回对象、无效计划 | 通过；无效写入和计划被拒绝，对象修改不改变已提交状态。 |
| I/O 失败 | 原生归档完成后注入确认失败 | 通过；Module 暂停后续写入，重开以日志保守对账，不把未知完成状态当作成功。 |
| 已观察外部变化 | 取消归档再归档，两个帧早于队列对账；完整重开 | 通过；所有权退出并持久化失效，后续原生归档不使旧条目重新出现。 |
| 失效清理故障 | putEntry 等待期间外部取消后再归档；冲突回执落盘后 deleteEntry 故障 | 通过；失效条目故意残留，完整重开按日志清理，并保留后来的原生归档。 |
| 活动检查等待竞态 | 已归档对象 intent 后 activity 暂缓，期间取消归档或取消后再归档 | 两个场景通过；插件原生 archive 调用次数为 0，不覆盖已观察的外部变化。 |
| 卸载与 lease | 在途原生调用、在途 putEntry、卸载期间外部变化、另一个持锁进程死亡 | 通过；新请求拒绝，在途操作完成 drain 后才释放，外部变化仍捕获；第二进程无法争用，持有者死亡后可接手。 |
| 初始化取消 | 真实 Cordis 在继承 Service.init 的第一个异步文件操作期间取消；锁文件已创建 | 通过；实际初始化报 INACTIVE_EFFECT，服务移除，lease 立即可重新取得；未添加生产测试钩子。 |
| tarball 与 Loader | 离线 npm pack、解包、exports 解析、insert patch、真实 Cordis Loader 加载、移入、卸载、再加载、恢复 | 通过；仅白名单发布内容，共享锁定 SDK，domain 及 lease 在卸载后释放；不等于完整 profile/CLI 安装。 |

两个测试文件共 **17 项测试全部通过**，其中真实进程终止的两项分别包含 5 个持久化边界。测试源为 [生命周期测试](../../tests/lifecycle.test.mjs)及[竞态回归](../../tests/recovery-races.test.mjs)，隔离宿主使用真实 JSONL、WorkspaceRegistry 与 domain Implementation，故障只注入在存储或原生边界。tarball 验证脚本为[打包检查](../../scripts/verify-package.mjs)。

## 产物与限制

测试数据、两个编码的临时会话、故障样本及 tarball 保留在忽略的 `.local/lifecycle/` 随机目录。打包检查打印 tarball、SHA-256、文件白名单和 SDK 版本，并保存 `verification.json`。测试没有连接当前 Web GUI，没有读写真实用户会话，也没有实现或执行永久删除。

本轮覆盖的是 macOS ARM64 与固定公开 SDK。活动提供方为 fixture，没有启动真实 Agent turns、subagents、jobs 或 schedules；运行保护依赖原生 waterfall 的已验证拒绝行为。Linux 未执行本地验证，Windows 的 lease 能力会拒绝加载。支持部署仍为一个 Host 拥有原生 Workspace 存储；协作插件 lease 不协调其他 Host 的原生写入。未观察或尚未持久化的取消归档再归档无法恢复精确归属，详见[Host 生命周期](../host-lifecycle.md)。

该 Host 验证未覆盖完整 DSH profile/CLI 安装、真实浏览器渲染、浅深色、键盘、中文输入法和窄屏。对应客户端及 Remote 的运行证据见[客户端验证](client-interface.md)，不扩大本报告的 fixture 范围。[CI 配置](../../.github/workflows/host-lifecycle.yml)和[首轮兼容性探针](dsh-0.2-compatibility.md)分别记录相关流程与独立证据。
