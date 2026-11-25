# 源码目录说明

本目录包含 `@takboo/dsh-session-bin` 的 Host、Client、操作契约与 Remote 通信实现。正式行为契约见 [Host 生命周期](../docs/host-lifecycle.md) 与 [客户端接口](../docs/client-interface.md)。

## 顶层结构

| 路径 | 职责 |
| --- | --- |
| [index.ts](index.ts) | 插件 Host 主入口、Cordis 服务注册与包顶层公开导出 |
| [host/](host/) | Host 侧归档集合管理、租约协调、永久删除准入/执行/恢复与持久化存储 |
| [client/](client/) | Web 客户端入口、状态模型、UI 组件、中英文文案、批量删除逻辑与样式 |
| [operations/](operations/) | 归档与永久删除操作计划、结果结构与 schema 定义 |
| [remote/](remote/) | Host 与 Client 之间的 Remote 接口契约定义 |

## 模块明细

### [host/](host/)

- [module.ts](host/module.ts)：Host 服务模块装配、生命周期挂载与卸载清理。
- [archive.ts](host/archive.ts)：原生归档集合查询、筛选、取消归档与元数据组装。
- [native.ts](host/native.ts)：宿主原生服务能力桥接与活动检查。
- [lease.ts](host/lease.ts)：单 Host 协调目录租约获取与释放。
- [store.ts](host/store.ts)：插件存储域持久化辅助。
- [remote.ts](host/remote.ts)：Host 侧 Remote 处理器注册与方法分发。
- [retirement.ts](host/retirement.ts) / [retirement-store.ts](host/retirement-store.ts)：旧 Bin core 退休/回执兼容与存储域读写。
- [retirement-owner.ts](host/retirement-owner.ts) / [retirement-owner-store.ts](host/retirement-owner-store.ts)：独立 owner 永久删除协调、批量执行与恢复状态持久化。
- [native-retirement-admission.ts](host/native-retirement-admission.ts)：运行时、平台/架构、文件系统与存储提供方永久删除准入校验。
- [native-retirement-sdk.ts](host/native-retirement-sdk.ts)：宿主 SDK 源码与接口特征核验。
- [native-retirement-owner.ts](host/native-retirement-owner.ts)：原生归档永久删除准备、冷会话复核与执行编排。
- [native-retirement-metadata.ts](host/native-retirement-metadata.ts)：会话头、工作区实体、投影缓存与 SQLite 查询索引清理。
- [native-retirement-persistence.ts](host/native-retirement-persistence.ts)：持久化提供方删除适配封装。
- [native-jsonl-files.ts](host/native-jsonl-files.ts)：JSONL 会话文件、多代 raw/zstd 日志与 `session.lock` 安全处理。
- [platform-files.ts](host/platform-files.ts)：跨平台文件系统识别与底层文件操作封装。

### [client/](client/)

- [index.ts](client/index.ts)：Web 客户端插件模块入口、侧栏/面板注册。
- [model.ts](client/model.ts)：客户端状态管理、筛选、选择、批量与恢复协调逻辑。
- [components.tsx](client/components.tsx)：原生控件与语义 token 构建的归档列表、确认弹窗与进度面板组件。
- [purge-batch.ts](client/purge-batch.ts)：固定对象范围的批量/清空永久删除状态辅助。
- [retirement-digest.ts](client/retirement-digest.ts)：批量与恢复结果摘要格式化。
- [locales.ts](client/locales.ts)：中英文界面文案词典。
- [panel.module.css](client/panel.module.css)：面板布局与语义 token 样式。
- [assets.d.ts](client/assets.d.ts)：CSS Modules 类型声明。

### [operations/](operations/)

- [index.ts](operations/index.ts)：`./operations` 子路径导出汇总。
- [archive.ts](operations/archive.ts)：原生归档管理操作契约与校验 schema。
- [retirement.ts](operations/retirement.ts)：永久删除计划、阻断项、逐项结果与回执契约。
- [retirement-owner.ts](operations/retirement-owner.ts)：独立 owner 协调与批量删除契约。
- [schema.ts](operations/schema.ts)：公共基础校验 schema。

### [remote/](remote/)

- [contracts.ts](remote/contracts.ts)：`./remote` 子路径导出的 Host-Client 远程调用类型与协议契约。
