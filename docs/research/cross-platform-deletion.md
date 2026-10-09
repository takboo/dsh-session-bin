# 跨平台永久删除调研（Windows / macOS / Linux）

本文记录永久删除能力扩展到 Windows、并保持 macOS/Linux 支持所需的一手事实：锁定依赖的平台行为、锁互操作性、Node/libuv 在 Windows 的文件系统与进程差异、仓库现有代码的平台耦合，以及由此可实现的 Windows 删除方案依据。只区分"已证实事实"与"待实测项"，不将可行性表述为验收证据。当前已验收删除组合仍以 [README](../../README.md) 声明为准（DSH `0.2.0-rc.2`、Node `24.18.1`、macOS ARM64、单 Host）；[分发与发布](../release.md) 要求永久删除仅为独立验证通过的宿主/存储组合启用，未实测平台不得宣称支持。

证据来源分级：**[S]** = 仓库锁定源码（node_modules 内固定版本，可直接复核）；**[D]** = 官方一手文档（Microsoft Learn / nodejs.org 文档源 / man7 / libuv·Cygwin 官方源码仓库）；**[I]** = 由前两者推出的推断，需真机实测确认。

## 1. 锁定依赖的平台事实

### 1.1 `@deepseek-ai/node-addon-system` 0.1.2：仅 POSIX flock，无 Windows 产物

**[S]** `node_modules/@deepseek-ai/node-addon-system/package.json`：`optionalDependencies` 只列 `darwin-arm64/darwin-x64/linux-x64/linux-arm64` 四个平台包，没有 win32 包。

**[S]** `lib/flock.js:9-15`：`loadBinding()` 在 `platform !== 'linux' && platform !== 'darwin'` 时抛 `ERR_FLOCK_UNSUPPORTED_PLATFORM`。README.md 同句声明："Missing or unloadable flock bindings reject acquisition, without installation-time compilation"。

**[S]** `src/flock.c:55-59`：原生实现就是 `flock(request->fd, LOCK_EX | LOCK_NB)`，无任何 Windows 分支、无 LockFileEx。该包内**不存在 LockFileEx 实现**。

结论：依赖 `tryLockExclusive` 的 POSIX 路径在 Windows 上会拒绝。插件的 Windows 路径按下一节的 SDK 信号量协议单独实现，不调用该 addon；具体选择见[平台文件 Adapter](../../src/host/platform-files.ts)与[JSONL 文件 Adapter](../../src/host/native-jsonl-files.ts)。

### 1.2 `@deepseek-ai/dsh-session-persistence-jsonl` 0.2.0-rc.2：Windows writer lock 是命名内核信号量，不是文件锁

**[S]** `node_modules/@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js:612-731`（`SessionWriteLease`）：

- POSIX 分支：对 `session.lock` 取 `tryLockExclusive`（flock `LOCK_EX|LOCK_NB`），加锁后以 `handle.stat({bigint:true})` 对照 `stat(path)` 的 `ino+dev` 复核"锁的仍是路径当前指向的 inode"，最多重试 3 次。锁文件从不删除。
- win32 分支（`process.platform === "win32"`，`index.js:673-685`）：调用 `acquireLockHandleWin32(path)`，失败码 `EBUSY` 映射 `SessionAlreadyOwnedError`。模块文档注释（`index.js:616-631`）明确："Windows holds a named kernel semaphore derived from that path — never a file lock or handle... Windows has no lock file at all."

**[S]** `index.js:556-577` 的 Win32 实现（经 koffi 3.1.1 FFI）：

- 名字：`Local\dsh-session-lock-${sha256(resolve(path).toLowerCase()).digest('hex')}`，其中 `path` 是 `join(会话目录, "session.lock")` 的**路径字符串**（Windows 上并不存在该文件，名字仅由路径派生）；`toLowerCase()` 是 JS 的 locale 无关实现。
- 获取：`CreateSemaphoreW(null, 1, 1, name)` + `WaitForSingleObject(handle, 0)`；`WAIT_OBJECT_0(0)` 持有，`WAIT_TIMEOUT(258)` → 关句柄并以 `ERROR_SHARING_VIOLATION(32)`→`EBUSY` 拒绝。
- 释放：`ReleaseSemaphore(handle, 1, null)` + `CloseHandle`。
- 同文件 465-491：koffi 懒加载 kernel32（非 Windows 进程不加载）；`index.js:586-609` Windows 目录持久化用 `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` + 临时目录 staging rename。

**[S]** koffi 3.1.1（`node_modules/koffi/package.json`）自带 `@koromix/koffi-win32-x64/-arm64/-ia32` 预编译包，Windows 无需编译（仓库 `mise run install` 的 `--ignore-scripts` 不影响其 prebuild 路径）。

**[D]** [CreateSemaphoreW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createsemaphorew)（synchapi.h）证实语义：命名对象已存在时参数 `lInitialCount/lMaximumCount` 被忽略并返回既有对象句柄（`GetLastError()==ERROR_ALREADY_EXISTS`）；"The semaphore object is destroyed when its last handle has been closed"，且"The system closes the handle automatically when the process terminates"——**崩溃即释放**，与 SDK 注释"kernel releases the lock when the holder's descriptor or last object handle closes, including on any process death"一致。名字大小写敏感、长度限 MAX_PATH、`Local\` 前缀指向登录会话（session）命名空间。

### 1.3 `acquireLease` 是后端内部入口，不能当作公共 retirement Interface

**[S]** `index.js:2923-2934`：`Jsonl` 实现提供 `acquireLease(id, cwd, dir = sessionDir(...))` 与 `acquireWriteLease(header)`，`open(id,'write')` 内部同样经 `acquireLease(id, undefined, dirname(resolved.currentPath))` 取锁（`index.js:2491`）。但公开包的 `lib/types/index.d.ts:192` 将 `acquireLease` 声明为 **private**；`acquireWriteLease` 虽在具体类声明中可见，仍会检查布局并创建目录，不是无副作用的 retirement 租约。调用内部入口只能属于独立审计的版本 Adapter，不能写作宿主提供了公共删除能力。本插件按 1.2 的名字规则自行取得 Windows 同 namespace 租约（见 §5.1），不调用这些会创建目录的入口。

## 2. 锁互操作性：flock × LockFileEx × 内核信号量

本仓库删除安全依赖"与 SDK writer 互斥"。锁定栈内事实：

**[S]** POSIX（macOS/Linux）：SDK 与插件都走 flock(2)。**[D]** [flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)：锁绑定 open file description，所有副本 fd 关闭或显式 `LOCK_UN` 释放；Linux 上 flock 与 fcntl(2) 记录锁**互不作用**（"there is no interaction between the types of lock placed by flock() and fcntl(2)"）；NFS 上 flock 被模拟为 fcntl 锁、SMB（CIFS）上 5.5 起为全文件字节范围锁。

**[S]** Windows（SDK）：互斥由命名内核信号量承载，**与任何文件字节范围锁（LockFileEx）无交集**。因此"系统 addon 的 LockFileEx 与 flock 是否互操作"对锁定栈而言不成立——两边都不用 LockFileEx。

第三方边界情况（对边界审计有用，不影响 SDK 契约）：

- **[D]** [LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)：按句柄的字节范围锁，进程终止或关闭句柄时由 OS 解锁（"If a process terminates with a portion of a file locked... the locks are unlocked by the operating system"）。Windows 上不存在 flock(2)，二者无同一 OS 内的直接互操作对象。
- **Cygwin/MSYS2 进程的 flock**：**[D]** Cygwin 官方源码 [winsup/cygwin/flock.cc](https://cygwin.com/git/?p=newlib-cygwin.git;a=blob_plain;f=winsup/cygwin/flock.cc;hb=HEAD) 以 `NtLockFile/NtUnlockFile`（NT 字节范围锁，LockFileEx 的底层原语）+ NT 命名空间事件对象实现 BSD 风格 flock。因此 Cygwin flock 与 LockFileEx 同源可交互，但**与 SDK 的内核信号量互不相干**——即 Windows 上经 MSYS2/Cygwin 的第三方 flock 持锁不会、也无法阻止 SDK writer。
- **WSL**：**[I]** 未找到任何 Microsoft 官方文档声明 WSL（9P/drvfs `/mnt/c`）上的 flock 与 Windows 字节范围锁或内核对象互操作；视为未验证，不纳入安全论证。同理与信号量无关。

结论：Windows 上唯一能与 SDK writer 互斥的方式就是**进入 SDK 自己的信号量 namespace**（同一名字推导 + 同一获取协议）。任何 plugin 私有 namespace 的锁不能证明 writer 排他，只能用于插件自身的 Bin 域互斥（现状 `src/host/lease.ts` 的 `purpose: 'plugin'` 即此用途）。

## 3. Node 24.18.1 / libuv 1.52.1 在 Windows 的文件系统行为

Node `24.18.1` 内置 libuv `1.52.1`（本仓库 mise 固定版本实测 `node -p process.versions.uv`）。以下均为锁定运行时对应的 [libuv v1.52.1 源码](https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c) 与 Node v24.18.1 文档源的事实；**较旧 libuv 的行为不同（见 3.6），勿外推**。

### 3.1 `O_NOFOLLOW` 是 no-op

**[S/D]** [include/uv/win.h:675-698](https://github.com/libuv/libuv/blob/v1.52.1/include/uv/win.h)：`UV_FS_O_NOFOLLOW 0`、`UV_FS_O_DIRECTORY 0`、`UV_FS_O_SYMLINK 0`。即 `fs.open(path, flags|O_NOFOLLOW)` 在 Windows **静默跟随符号链接/junction**，不报 ELOOP。Node 文档（doc/api/fs.md，v24.18.1 tag）的 flag 表无 Windows 警告，libuv 头文件是决定性证据。替代：`lstat` 先行拒 `S_IFLNK`（见 3.5）或经 koffi `CreateFileW + FILE_FLAG_OPEN_REPARSE_POINT`。

### 3.2 目录可打开但不可 fsync

**[S]** libuv `fs__open` 无条件附加 `FILE_FLAG_BACKUP_SEMANTICS`（"Setting this flag makes it possible to open a directory"）且共享模式恒为 `FILE_SHARE_READ|WRITE|DELETE`（除非 `O_EXLOCK`）。因此 `fs.open(dir,'r')` 可行。但 `fs__sync_impl` = `FlushFileBuffers(handle)`；**[D]** [FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)："The file handle must have the GENERIC_WRITE access right"——只读目录句柄必然 `ERROR_ACCESS_DENIED`。**Node 在 Windows 没有目录 fsync**（volume 句柄 flush 另需管理员）。持久化替代 = SDK 已用的 `MoveFileExW(MOVEFILE_WRITE_THROUGH)`（重命名）与 NTFS 元数据日志；删除侧见 §5.3。

### 3.3 `unlink` 已是 POSIX 语义删除（优先路径）

**[S]** libuv `fs__unlink_rmdir`（process.c 同名逻辑见 fs.c）：以 `FILE_READ_ATTRIBUTES|DELETE` + `FILE_FLAG_OPEN_REPARSE_POINT|FILE_FLAG_BACKUP_SEMANTICS` 开自身句柄（**删的是 reparse point 本身，不落目标**），先尝试 `NtSetInformationFile(FileDispositionInformationEx)`，flags = `FILE_DISPOSITION_DELETE | FILE_DISPOSITION_POSIX_SEMANTICS | FILE_DISPOSITION_IGNORE_READONLY_ATTRIBUTE`；失败时按错误码回退到传统 delete-on-close + 只读属性摘除。**[D]** [DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew) 证实两条路径差异：POSIX delete"causes the file to be deleted while handles remain open. Subsequent calls to CreateFile... fail with ERROR_FILE_NOT_FOUND"；传统路径"marks a file for deletion on close... until the last handle to the file is closed. Subsequent calls to CreateFile... fail with ERROR_ACCESS_DENIED"，且若存在未按 `FILE_SHARE_DELETE` 打开的他人句柄则删除失败。Node 句柄恒带 `FILE_SHARE_DELETE`（3.2），插件自己持有的 fd 不阻塞 unlink；AV/索引器等非 libuv 句柄可能让 unlink 报 `EBUSY/EPERM`——必须按可重试失败处理而非损坏。

### 3.4 stat 的 `ino/dev/birthtime` 在本版本为真值；`nlink` 仅 fstat 为真

**[S]** libuv 1.52.1 `fs__stat_handle`（fd/fstat 路径）：`FileAllInformation` 查询，`st_ino = InternalInformation.IndexNumber.QuadPart`（NTFS 文件引用号 64 位）、`st_dev = VolumeSerialNumber.LowPart`、`st_nlink = StandardInformation.NumberOfLinks`（真实硬链接数）、`st_birthtim = CreationTime`。`fs__fstat_handle` 对普通文件走同一路径。

**[S]** 路径版 `stat/lstat`（`fs__stat_impl_from_path`）优先走 `NtQueryDirectoryFile(FileIdFullDirectoryInformation)` 快路径：`FileId`、卷序列号、CreationTime 为真值，但 **`NumberOfLinks = 1` 硬编码**（源码注释 "No way to recover this info"）；仅快路径失败才落到句柄路径取真值。

推论：Windows 上 `lstat(path).nlink === 1` 不可作为"无额外硬链接"的证据；`FileHandle.stat()`（fstat）才可以。`dev/ino/birthtimeNs` 三元组在 Windows 可用且语义与 POSIX 对应（dev=卷序列号、ino=文件 ID、birthtime=创建时间，NTFS 100ns 精度）。**[D]** Node 文档 `stats.ino` 仅写 "file system specific Inode number"，未再声明 Windows 恒 0——旧版（libuv < 1.49 一系列实现）确曾为 0 或 GetFileInformationByHandle 派生，**该结论版本敏感，仅对本锁定运行时负责**。

### 3.5 reparse point：junction 按 symlink 处理；创建符号链接需特权

**[S]** libuv `fs__stat_assign_statbuf` 注释与实现：`lstat` 下带 `FILE_ATTRIBUTE_REPARSE_POINT` 的条目（"symlinks and mount points, both of which are treated as POSIX symlinks"）置 `S_IFLNK`；非 reparse 的其他形态按普通文件/目录。即 `lstat().isSymbolicLink()` 在 Windows 覆盖 symlink + junction（mount point）。junction 创建不需要管理员（`mklink /J` 层面），符号链接创建需要：**[D]** [CreateSymbolicLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw) 的 `SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE` 需先启用 Developer Mode，否则需提升权限。**[D]** Node `fs.symlink` 的 `type`（'dir'|'file'|'junction'）仅 Windows 有效。

### 3.6 `truncate` 与写句柄 fsync 可用

**[S]** `fs__ftruncate`：`NtSetInformationFile(FileEndOfFileInformation)`；`fs__fsync`：`FlushFileBuffers`（需句柄以写方式打开，如 `O_RDWR`）。即"打开写句柄 → ftruncate(0) → fsync"在 Windows 是可行且语义正确的清零持久化序列。

## 4. 进程与信号差异

**[D]** Node v24.18.1 doc/api/child_process.md（`subprocess.kill`）："On Windows, where POSIX signals do not exist, the signal argument will be ignored except for 'SIGKILL', 'SIGTERM', 'SIGINT' and 'SIGQUIT', and the process will always be killed forcefully and abruptly (similar to 'SIGKILL')."

**[D]** doc/api/process.md（Signal Events / Windows 段）："Windows does not support signals... Node.js offers some emulation with process.kill() and subprocess.kill(): Sending SIGINT, SIGTERM, and SIGKILL will cause the unconditional termination of the target process, and afterwards, subprocess will report that the process was terminated by signal."

**[S]** libuv 1.52.1 `uv__kill`（[src/win/process.c](https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c)）：SIGKILL/SIGTERM/SIGINT/SIGQUIT 一律 `TerminateProcess(handle, 1)`，注释"On Windows, killed processes normally return 1"。

对测试的含义：

- 父进程侧 `worker.kill('SIGKILL')`（超时兜底）：Windows 有模拟，强制终止等价 SIGKILL；fork 侧 signal 上报属 Node 记账（文档声明会报 signal）。**[I]** 精确到 `assert.equal(signal,'SIGKILL')` 仍需真机确认。
- worker 自杀 `process.kill(process.pid,'SIGKILL')`（crash-injection checkpoint）：Windows 上是 TerminateProcess 退出码 1，**[I]** 父进程大概率看到 `exitCode=1, signal=null`，现有 `assert.equal(signal,'SIGKILL')` 断言预期失败，需改为"异常退出"断言（需实测定案）。崩溃注入本身（无清理的突死）语义等价。
- `process.kill(-pid)`（进程组）为 POSIX-only；`scripts/verify-gui.mjs:130-137` 已按 `win32` 分支处理并有 `detached: platform!=='win32'` 先例。

## 5. Windows 永久删除方案评估

以下按 §1-§4 事实校验主线设计（排他租约 + 已持久化 operation 维护域内 exact FD 验证后 truncate(0)+sync 再 unlink + 0 长资源续 operation）。逐项给出依据与必须保留/修正的点。

### 5.1 排他租约：必须进入 SDK 信号量 namespace

- 正确路径：对**已确认存在**的会话目录，以 `join(dir,'session.lock')` 路径推导 SDK 同名信号量并按 `CreateSemaphoreW(1,1)+WaitForSingleObject(0)` 协议获取（与 `src/host/platform-files.ts` 的 `windowsSemaphoreName(path,'session')`/`acquireWindowsSemaphore` 一致）。这是唯一能令 SDK writer `SessionAlreadyOwnedError` 的互斥。名字推导必须逐字复刻：`resolve()`（node:path，win32 形态）→ `toLowerCase()` → sha256 hex → `Local\dsh-session-lock-` 前缀。**[S]** 双方同函数同序即同名；任何 realpath/8.3 短名/`\\?\` 前缀差异都会产生不同名字——这是 SDK 契约的固有属性（两个进程各自用别名路径时本就不互斥），插件不得"顺手规范化"，否则在别名场景反而破坏互斥。
- 复用 `backend.acquireLease(...)`（§1.3）亦可：二选一，但自实现可被仓库 SDK 文件哈希钉死（`src/host/native-retirement-sdk.ts` 已含 persistence-jsonl `lib/index.js` sha256），版本升级时 diff 可审。注意 acquireLease 前置 `mkdir(dir,{recursive:true})`（`index.js:668-671`）——对不存在目录会**创建**，故必须先自行断言目录存在；POSIX 侧它还会以 `open(path,'w')`（含 O_TRUNC）打开锁文件，误用路径有截断风险，插件 POSIX 路径应继续用自己的 `O_RDWR|O_NOFOLLOW` flock 流程（现状如此）。
- plugin 私有 namespace（`dsh-session-bin-lock-*`）只可用于插件自有域（如 Bin writer.lock 互斥，现状 lease.ts 用法正确），**不可**作为会话删除的排他证据。
- 信号量对象生命周期由句柄承载（§1.2 崩溃即释放），无需 stale 检测/PID 文件/过期；持有期内"wedged but alive"进程保持互斥是 SDK 有意语义，插件不得加超时抢占。

### 5.2 Windows 无 `session.lock` 文件：inventory 的 lock 身份必须换轴

**[S]** Windows 上 SDK 从不创建 `session.lock`。当前 `nativeJsonlInventorySchema.lock` 的 inode 身份（`lockIdentitySchema`）与 `rows()` 的 `jsonl/lock-missing` 拒绝均为 POSIX 专属。Windows 版应以 `{kind:'win32-semaphore', name}`（现 `windowsLockSchema`）入清单——name 即互斥对象身份，同时目录身份（root/directory 的 dev/ino/birthtimeNs）继续用 §3.4 的真值三元组绑定 incarnation。

### 5.3 erase 顺序：truncate(0) → fsync → unlink 成立，且有 Windows 专属依据

主张：在已持久化冻结 operation/fence 的维护域内，exact FD 验证后对资源 `truncate(0)+fd.sync` 再 `unlink`；重启后未知 0 长文件以同 dev/ino/birth 续原 operation；普通 prepare/清单仍拒绝未知空 header。校验：

1. `ftruncate(0)` + `FlushFileBuffers`（需 `O_RDWR` 打开）使零长度先于删除持久（§3.6）。**[D]** FlushFileBuffers 将该文件缓冲数据落盘（含其元数据写穿语义，见 doc 与 FILE_FLAG_WRITE_THROUGH 说明）。
2. 随后 `fs.unlink` 走 libuv 的 POSIX-semantics 删除（§3.3）：Win10 1607+/NTFS 上名字立即消失、后续 open 得 ENOENT，自身句柄不阻塞；旧系统/非 NTFS 回退 delete-on-close——此时**最后一个句柄关闭前名字仍可见、重 open 得 ACCESS_DENIED**，故"unlink 后重开验证空"的顺序必须放在关闭擦除句柄之后，或按错误码区分 delete-pending。**[I]** 目标环境的实际路径选择需真机确认。
3. 掉电回滚安全性：Windows 无目录 fsync（§3.2），NTFS 元数据日志回滚可能恢复已删名字；POSIX 无目录 fsync 时 unlink 同样可回滚。两侧共同的防线正是"先持久清零再删名字"：即使名字回滚，恢复的文件内容为空，不回放日志内容。这提供 Windows 删除协议的一道内容防复活措施。既有 POSIX 的七个 SIGKILL 边界针对 plugin/owner 的持久化阶段，POSIX 文件动作仍为逐文件 unlink + 目录 fsync；它们没有验收 Windows 的 truncate/sync 与 unlink 之间窗口。Windows 还须实际终止进程验收该独立窗口。0 长续 operation 的身份轴（dev/ino/birthtimeNs 在 truncate 后不变，§3.4）成立；mtime/ctime 会变，不能入续接身份。
4. 非插件句柄（AV、索引、备份）令 unlink 报 EBUSY/EPERM 时（§3.3）按失败重试/中止处理，不得视为范围变化或强制后续。
5. 该顺序**不是安全擦除**：未分配簇、驻留 MFT 数据、卷影/备份中的旧字节不受影响（与 POSIX unlink 同级），与"不宣称安全擦除"的边界一致。

### 5.4 资源身份与硬链接检查必须挂在 fstat 上

§3.4：Windows 路径 stat 的 `nlink` 恒 1。当前 `eraseInner` 的 `fileIdentity(await lstat(absolute))`（身份复核）与 `readRow` 的 fd.stat 双查里，**只有 fd.stat 腿在 Windows 有效**。Windows 分支应将"独占普通文件、无额外硬链接"的拒绝条件放在打开句柄后的 `handle.stat()`；lstat 前置检查仅保留 isFile/reparse 拒绝用途。`openRegularFile`（platform-files.ts）已按"lstat 拒链接 + fstat 全身份比对"实现，方向正确；其 TOCTOU 残余（lstat 与 open 之间换成指向同文件的 symlink，follow 后 fstat 身份相同）为 Windows 纯 Node 不可消除项，如需闭合须经 koffi `FILE_FLAG_OPEN_REPARSE_POINT` 打开（可选加固，非阻塞项）。

### 5.5 明确不能宣称/未验证的事项

- Windows 原生 runner 的删除验收尚无运行证据；Linux ARM64 已执行真实 Linux 内核、独立容器文件系统的 candidate 验收，报告不自动扩大生产资格，也不证明独立 Linux 桌面 GUI。实际基线与结果见[Host 验证](../verification/host-lifecycle.md)。
- WSL/Cygwin/MSYS2 与 SDK 锁互操作：无官方文档，不承诺。
- Windows 目录元数据持久化时点不可从用户态强制（无目录 fsync）；依赖 NTFS 日志一致性 + 先清零顺序，不改结论但应写入限制声明。
- `Local\` namespace 为登录会话域：不同登录会话/服务上下文中的进程不共享该信号量（**[D]** CreateSemaphoreW 的 Local/Global 说明）；单用户桌面场景成立。
- 旧 libuv/旧 Node 的 `ino=0` 行为不适用于本组合，版本门（Node `24.18.1` + SDK 哈希指纹）必须保持。

## 6. 仓库现有代码与测试的平台耦合清单

**[S]** src 侧：

- `src/host/platform-files.ts`（新增）：平台门 `nativePlatformCandidate`（darwin/linux/win32 × arm64/x64）与独立晋级的 `nativePlatformVerified`（当前 Windows x64、macOS ARM64/Intel、Linux ARM64/x64，且固定 Node `24.18.1` / libuv `1.52.1`）；Windows 信号量获取/释放、`syncDirectory`（win32 直接 return）、`openRegularFile`（lstat+fstat 双查）。与 §3/§5 的要求一致；`syncDirectory` 的 win32 no-op 是事实性无操作而非持久化。
- `src/host/native-jsonl-files.ts`：POSIX 通过既有 `session.lock` inode + flock 取排他；Windows 使用明确的 semaphore 清单身份与 SDK 同名 kernel 租约，不要求或创建锁文件。Windows 文件动作先同步清零再 unlink；只有已有 admission 的维护 scope 可以按冻结 dev/ino/birthtime 续同一空文件，普通 inventory 拒绝不完整 header。
- `src/host/native-retirement-owner.ts`：未验证平台只能由独立隔离 composition 显式提供 `platformQualification`；生产 Service 配置不接收它，默认资格以已实际验收组合为准。
- `src/host/native-retirement-metadata.ts`：projcache 文档使用实际 FD 的 fstat 核对硬链接数、读取前后身份和摘要；Windows 不伪造目录 fsync，SDK medium 删除与后续物理 absence、内存收敛分别检查。

**[S]** tests 侧：

- [平台 fixture](../../tests/helpers/platform-fixture.mjs)统一处理强制终止证据、独立 candidate 资格与协调身份。Windows checkpoint 在 kill 前落盘；父进程要求对应边界证据，拒绝 kill 返回、抛错或正常退出处理器留下的反证，不能仅凭 code 1 判定崩溃成功。
- [JSONL 文件回归](../../tests/native-jsonl-files.test.mjs)在 Windows 用 junction 覆盖 reparse 拒绝，不要求创建普通符号链接的额外特权；硬链接检查使用真实 FD 的 nlink。路径探针使用 node:path 与工作区边界，不依赖 `/tmp` 或字面 `/` 分隔符。
- [Windows cache 中断回归](../../tests/windows-cache-crash.test.mjs)只在实际 Windows candidate 流程启用，验证专属非 JSON stage 的 rename、清零、同步、删除与原操作恢复；其他平台跳过不构成 Windows 通过。

**[S]** scripts 侧：

- [浏览器发现](../../scripts/browser-executable.mjs)按 macOS、Windows、Linux 选择已安装 Chrome/Chromium，并提供 Edge 与配置覆盖及锁定工具缓存回退；[GUI 脚本](../../scripts/verify-gui.mjs)同时隔离 TMPDIR/TMP/TEMP。Windows 宿主通过隔离 Node IPC 交给 SDK 原有 SIGTERM 处理器排空，单独记录这一投递方式，不伪称原生 POSIX 信号。
- [包管理器启动](../../scripts/package-manager.mjs)区分 mise 的原生 pnpm 可执行文件与 Corepack JavaScript CLI；[构建](../../scripts/build.mjs)规范化产物路径。任务集中于[工具配置](../../mise.toml)和[项目 manifest](../../package.json)，无需 Windows Bash shell。
- [平台验收](../../scripts/verify-platform.mjs)保存实际 OS/arch、源码指纹与退出码；[Linux 容器验收](../../scripts/verify-linux.mjs)将源码复制到独立容器文件系统，不能把它描述为 Windows 或独立 Linux 桌面 GUI。最终运行证据见[Host 验证](../verification/host-lifecycle.md)和[客户端验证](../verification/client-interface.md)。

## 7. Linux/macOS 侧补充约束（保持既有支持）

- **[D]** flock 语义：本地文件系统成立；NFS/SMB 挂载有模拟语义差异（man7 flock NFS/SMB 段），DSH_HOME 在网络文件系统上应按未支持组合拒绝。
- **[I]** Linux `birthtimeNs` 依赖 statx：ext4 可用；tmpfs/overlayfs 等可能返回 0/不可用，导致身份绑定失败——表现为 fail-closed 拒绝（安全方向），但 `/tmp` 类 DSH_HOME 会不可用，支持范围声明需体现。
- macOS 现状不变（已验收组合）。

## 8. 引用

锁定源码（仓库内，版本固定）：`node_modules/@deepseek-ai/node-addon-system@0.1.2`（package.json、README.md、lib/flock.js、src/flock.c）；`node_modules/@deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2/lib/index.js`；`node_modules/koffi@3.1.1/package.json`；`src/host/*`、`tests/*`、`scripts/*`。

官方一手文档：[CreateSemaphoreW](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-createsemaphorew)·[LockFileEx](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-lockfileex)·[DeleteFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-deletefilew)·[FlushFileBuffers](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-flushfilebuffers)·[SetFileInformationByHandle](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-setfileinformationbyhandle)·[FILE_INFO_BY_HANDLE_CLASS](https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ne-minwinbase-file_info_by_handle_class)·[CreateSymbolicLinkW](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createsymboliclinkw)（Microsoft Learn）；[flock(2)](https://man7.org/linux/man-pages/man2/flock.2.html)（man7.org）；[libuv v1.52.1 src/win/fs.c](https://github.com/libuv/libuv/blob/v1.52.1/src/win/fs.c)、[include/uv/win.h](https://github.com/libuv/libuv/blob/v1.52.1/include/uv/win.h)、[src/win/process.c](https://github.com/libuv/libuv/blob/v1.52.1/src/win/process.c)；Node v24.18.1 [doc/api/fs.md](https://github.com/nodejs/node/blob/v24.18.1/doc/api/fs.md)、[doc/api/child_process.md](https://github.com/nodejs/node/blob/v24.18.1/doc/api/child_process.md)、[doc/api/process.md](https://github.com/nodejs/node/blob/v24.18.1/doc/api/process.md)；Cygwin [winsup/cygwin/flock.cc](https://cygwin.com/git/?p=newlib-cygwin.git;a=blob_plain;f=winsup/cygwin/flock.cc;hb=HEAD)。

本地研究快照（`.local/`，不入库）：`libuv-win-fs-1.52.1.c`、`libuv-win.h`、`libuv-win-process.c`、`node-{fs,child_process,process}.md`、`cygwin-flock-head.cc`。
