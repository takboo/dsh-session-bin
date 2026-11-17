# DSH 0.2.2-rc.3 适配与恢复验证

Session Bin `0.3.2` 锁定 DSH `0.2.2-rc.3`，上游提交 `38a6a5c965aa99ab525161efb7cc5cf1fe62fced`。升级基线为已发布的 Session Bin `0.3.1` / DSH `0.2.2-rc.2`。所有删除和恢复操作使用临时 `DSH_HOME` 与独立会话。 [上游发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.3) · [适配 PR](https://github.com/takboo/dsh-session-bin/pull/32) · [rc.2 验证](dsh-0.2.2-rc2.md)

## 源码与准入

- npm 与官方 macOS ARM64 Desktop ASAR 的 18 份删除链路审计文件均与 rc.2 字节一致，覆盖 Cordis、Session/Agent、JSONL、Workspace、SQLite 查询及投影缓存。上游客户端增加新会话操作槽和工作区选择器工厂，Session Bin 继续通过原面板槽位挂载。 [上游源码对比](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.2.2-rc.2...dsh-v0.2.2-rc.3) · [候选巡检](https://github.com/takboo/dsh-session-bin/actions/runs/43403035642)
- 正式准入核对 rc.3 的宿主、SDK 文件 SHA-256 和 JSONL 私有类身份。schema 1 的资源 fingerprint、冻结清单和回执身份沿用 [ADR 0011](../decisions/0011-runtime-and-durable-retirement-identity.md)。运行时、平台、文件系统和存储范围见 [Host 契约](../host-lifecycle.md#真实冷-jsonl-单项删除-adapter)。

## 正式验收

2026-11-17。正式构建基线为 `716c5e50c18534d6f55bf9b67d0b991f2973c641`，使用 Node `24.18.1`、pnpm `11.23.0` 和冻结锁文件。五个平台的文件系统、删除资格、真实 Loader 及双语 CLI/Web 报告保存在 [生命周期 CI](https://github.com/takboo/dsh-session-bin/actions/runs/44027950307)。最终合并提交及同一 tarball 的发布证据见 [PR #32](https://github.com/takboo/dsh-session-bin/pull/32)。

官方 macOS ARM64 Desktop ZIP 的 SHA-256 为 `1648a29609710d852f04fb3c50602ff37b1ed0def1d2aff65ce813daa5a4f4a4`，feed SHA-512、应用签名与 Team ID `NAN929V4UM` 均通过复核。实际 Electron `44.7.0` / Node `24.21.0` / libuv `1.52.1` 在 APFS 上通过 ASAR 生产准入 probe。macOS `27.2` 上的 Electron 双语 Web 检查各通过 18 项，四次 Host 正常退出，浏览器 console 与页面错误均为空。两种语言使用相同的预编译 tarball，SHA-256 为 `e25de03e62ccc3fef5e5cced266a110e761e36b88fd3abc0d81390a9691a6ab6`。

冷升级使用 npm 发布的 `0.3.1` 原样 `dist`（tarball SHA-256 `fcd8530b27a8a1c209cb780eff3f30cc79a5b22ec2d7f45621506442b0ca8d8b`）生成样本。独立 Node 和官方 Electron/ASAR 分别用 `0.3.2` 重开本载体的 rc.2 数据，各通过 8 组：

| 旧状态 | raw / zstd 检查 |
| --- | --- |
| prepared | 沿用原冻结计划和操作 ID，显式执行成功 |
| done | 同一操作的重复执行返回相同回执 |
| owner-fenced | 旧进程在 owner 围栏处实际 SIGKILL，重开恢复成功 |
| resource-effect | 旧进程在资源动作边界实际 SIGKILL，重开对账成功 |

每组都核对目标日志缺失及 sibling 日志保留。升级要求旧 Host 完全退出。桌面 Web 证据覆盖 Electron 载体内的公开 Web Host/Client，ASAR Host 由独立生产探针及生命周期套件覆盖。原生桌面 shell、真实账号和物理输入法未纳入本轮验收。
