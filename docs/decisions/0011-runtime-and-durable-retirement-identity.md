# ADR 0011：分离运行时准入与持久化删除协议身份

DSH `0.2.1-rc.1` 改动了 JSONL 提供方和 Agent 生命周期入口，但日志格式、锁、Workspace/cache schema 及冻结资源协议保持兼容，见[源码调研](../research/dsh-0.2.1-rc1.md)。升级时继续使用 schema 1 的资源 fingerprint、`hostVersion: 0.2.0-rc.2` 和 `sqlite-0.2.0-rc.2` 等历史协议标识，避免使已有 binding、grant、清单摘要和终态回执失效；这些字段不再解释为当前安装版本。

实际运行时另行核对宿主与全部参与包的精确版本和源码 SHA-256，并为新版独立完成平台验收。JSONL 私有类采用原始实例的构造器源码摘要校验，不能对 Cordis 代理的 native-code 包装取摘要。只有已核对协议兼容的版本可以复用持久化身份；未知版本仍拒绝删除。本决定覆盖旧进程完全关闭后的重开，不授权跨 SDK 热接管、不修改原生归档状态，也不为新的或变化的资源清单提供自动删除授权。跨版本 prepared、pending 与 done 的实际证据归[兼容性验证](../verification/dsh-0.2.1-rc1.md)。
