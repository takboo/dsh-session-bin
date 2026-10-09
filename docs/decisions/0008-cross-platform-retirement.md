# ADR 0008：跨平台内核租约与独立生产资格

状态：已采用。决定的是平台 Adapter、恢复语义及发布门槛；实际通过的平台组合以 README 和验证报告为准。

## 背景

正式发布须支持 Windows、macOS、Linux。锁定 DSH `0.2.0-rc.2` 在 POSIX 使用既有 `session.lock` inode 的 flock，Windows 则使用由该路径字符串派生的命名内核信号量，并不创建锁文件。Windows 没有 Node 目录 fsync，路径 stat 的硬链接数量也不足以证明文件独占。一手依据见[跨平台调研](../research/cross-platform-deletion.md)。

## 决定

1. 保持原生归档、固定观察、exact lifecycle、冻结资源清单、一次性授权和逐资源 journal 的公共 Interface。平台差异位于现有文件与租约 Seam 的内部 Implementation，不能传播成客户端提供任意路径或绕过活动保护的新入口。
2. 插件 lifetime lease 采用 POSIX flock 或独立的 Windows `dsh-session-bin-lock-*` 信号量。会话删除采用 SDK 相同的原生 writer 租约：POSIX 保留既有空锁 inode，Windows 使用精确的 `Local\\dsh-session-lock-*` 命名规则。Windows 路径别名不能导致双方锁名字不同；不创建会话锁文件、不停止其他 writer、不使用过期/PID 抢占。
3. 常规文件必须同时经过路径和已打开 FD 的身份复核；独占性以 fstat 的真实 nlink 为证据。ino 与 birthtime 不可用时拒绝，而不是将零值作为 incarnation。Node `24.18.1`、libuv `1.52.1` 和 SDK 源码/实例资格分别检查，祖先目录可信及稳定的原有假设继续适用。
4. POSIX 日志清除保持精确 unlink + 目录 fsync。Windows 对已确认独占文件先 truncate(0) + FD sync，再关闭 FD、unlink 和确认缺失；只有已保存 admission 的同操作维护 scope 可按冻结物理身份续办零长度文件，普通准备仍拒绝缺失 header。
5. Windows projection cache 不能在 SDK 会读取的原 `.json` 名字下留下空文件。先使用无 replace/copy fallback 的同卷 write-through rename 移到由 exact operation/lifecycle/快照派生的专属非 JSON stage，再核对身份与摘要、清零并同步、关闭并清除 stage；物理缺失确认后才清内存和发布通知。陌生 stage、旧 whole-unit bootstrap 源及资源漂移明确拒绝。共享资源、其他 SID 和私有 SQLite 行不直接清除。
6. 关闭只继续已接受的完整请求 frame 及其嵌套 I/O，拒绝新请求及等待后失去资格的旧请求；frame 结束后权限撤销，旧 callable alias 不能穿过同实例接管。
7. 实现候选平台与生产资格分开。生产 Service 只使用已验收组合，`permanentDeletion: true` 不绕过它。隔离验证通过独立构造依赖提供候选资格，测试根与 DSH_HOME 须绑定工作区临时 fixture；该资格不能来自 Host 配置或 Remote。缺少对应实际 OS 验收的组合不自动晋级。
8. 三平台的真实宿主、资源与进程死亡验收是发布硬门槛。Windows 自杀 code 1 不足以证明强制终止：注入前须持久化边界证据，kill 返回、抛错或正常 exit handler 运行须留下反证，父进程同时核对两者。源码模拟和平台拒绝检查不能替代实际 Windows 删除验收。

## 影响

旧 POSIX v1 清单继续可读，Windows 明确采用 semaphore 锁身份；启动和旧日志迁移不改变 native archive，不补授权。文件动作、cache medium、内存、SQLite 自身对账与 owner done 的确认顺序保持。此方案提供会话记录删除，不声明安全擦除、跨登录会话 Windows 协调或任意文件系统上的掉电保证。

正式协议见[Host 生命周期](../host-lifecycle.md)，发布条件见[分发与发布](../release.md)，状态及运行证据分别集中于 [README](../../README.md)和[Host 验证](../verification/host-lifecycle.md)。
