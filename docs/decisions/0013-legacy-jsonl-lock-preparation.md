# ADR 0013：显式删除准备可为旧 JSONL 首次建立稳定锁

状态：已采用，随 `0.2.9` 交付。后续修订 [ADR 0007](0007-native-jsonl-deletion-adapter.md) 中“缺少稳定锁一律拒绝”的首次接入规则；不改变已绑定目标的锁身份、持久化协议和生产环境准入。

## 背景

DSH `0.2.1-rc.5` 的 POSIX writer 在首次物化或写打开时建立 `session.lock`，普通历史读取不建立锁。旧 V0–V3 日志可存在于规范目录中且可被当前 SDK 读取，但从未取得当前 writer lease。插件原来要求已有锁，导致这些冷归档在删除准备时返回 `jsonl/lock-missing`，用户须恢复并加载会话才能继续。

## 决定

仅在显式永久删除准备的 eligibility 路径中、目标 admission 已排空、归档/活动/元数据检查已通过且没有持久化 lifecycle witness 时，调用 `NativeJsonlFiles.prepareLegacyLock`。启动、列举、普通 inspection、迁移和历史操作恢复均不补锁；已经形成 witness 的目标丢锁仍拒绝，不以新 inode 接替旧授权。

首次补锁仅接受规范唯一目录中的已提交 V0–V3 generations。先核实整个旧文件集合的 regular-file 身份、header、全字节摘要与目录身份；当前 V4、staging、未知文件、损坏 header、重复 SID、链接或其他异常继续拒绝。已有锁直接交给正常 inspection/acquisition 核验；不重写、截断或替换任何既有文件。

采用 `O_CREAT | O_EXCL | O_NOFOLLOW | O_RDWR`、权限 `0600` 建立空锁，再取得同 inode 的 `flock`，同步文件和父目录，复核目录、完整资源清单、FD 和路径的锁身份。并发创建返回 `EEXIST` 时不重试覆盖，由正常清单与内核锁检查验证获胜 inode 和 writer 争用。创建后的锁在取消、已知拒绝、未知 I/O 和进程终止后都保留，避免另一个 writer 持有孤立 inode。未知 I/O 继续暂停 owner，完整重开后才接受新的显式准备。

补锁只建立协调资源，不是删除授权。后续仍取得持久化 lifecycle、冻结清单、固定观察身份和单次 grant；执行重新检查活动、原生归档、资源和参与者。会话日志不写打开、不迁移、不改字节或时间戳；删除完成仍保留目录和稳定锁。Windows 继续使用原来的命名 semaphore 路径。

## 验证与边界

运行结果见[Host 验证](../verification/host-lifecycle.md#缺锁旧-jsonl-会话的显式接入)。沿用可信稳定祖先、协作单 Host 和已审计 SDK 假设；不能区分缺锁的全部历史原因，也不声称防御其他 Host 或恶意外部 namespace 改写。候选验证不会扩大生产宿主、运行时、平台/架构、文件系统或存储提供方资格。
