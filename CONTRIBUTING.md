# 贡献流程

项目功能、兼容范围与开发入门见 [README](README.md)。正式行为在[Host 生命周期](docs/host-lifecycle.md)与[客户端接口](docs/client-interface.md)，候选方案在[设计提案](docs/design-proposal.md)，版本兼容性证据在[验证文档](docs/verification/client-interface.md)。

## Issue 与分支

为功能和兼容性问题记录可复现的触发条件、期望行为与完成条件。涉及会话删除时列出目标 DSH 版本、存储提供方、活动状态和中断后的期望状态。会话名称与目录可能包含私人信息，提供问题样本时使用测试数据。

采用短期分支：`feat/<topic>`、`fix/<topic>`、`docs/<topic>`。本地默认分支为 `main`。使用 Conventional Commits，例如 `feat: add bin batch restore`；提交粒度围绕一个可审阅的行为变化。

## 变更与验证

使用 [mise.toml](mise.toml) 的固定工具。`mise run verify` 执行两端类型检查、构建、隔离行为测试与 tarball 检查；`mise run verify:gui` 在独立 CLI profile 与系统 Chromium 中验证真实交互。单项任务及前提见[客户端接口](docs/client-interface.md)。

会话状态变更需要从公共 Interface 检查成功、拒绝、重复提交和中断恢复。存储操作增加临时数据上的宿主集成验证，证明日志、查询索引和会话列表的一致性。界面验证覆盖原生浅色/深色、键盘、中文输入法和窄屏布局。对普通文案或样式调整采用与影响相称的检查。

测试在临时 DSH_HOME 中运行，提供独立的 fixture；默认不读写开发者的实际会话目录。SDK 支持范围只扩大到已有测试证据的版本。

## Pull request

说明具体问题、触发方式和修改后的行为，列出实际完成的验证与仍存在的限制。关联 originating issue 或对应设计完成条件。界面 PR 附真实的浅色和深色截图；生命周期 PR 列出涉及的活动、锁、并发和恢复场景。

[CI 配置](.github/workflows/host-lifecycle.yml)使用固定 mise 工具、frozen lockfile、禁用安装脚本和实际验证任务。PR 的检查结果以对应提交的运行记录为准；发布使用已通过检查的提交。远程仓库使用 required checks、PR 审阅和 release 环境规则，不绕过失败的检查。

## 文档与许可

README 保持简洁的项目说明、功能、安装和兼容范围；实现细节写入专题契约。研究文档保存带版本与出处的事实，设计提案保存候选方案，ADR 保存已落实且影响后续工作的决定，验证报告保存明确基线的检查结果与限制。临时会话交接、代理分工和下一轮安排留在会话、issue/PR 或提交说明中，不写入长期文档。用户安装说明和兼容性表依据实际安装证据，复用代码附来源并保留上游版权。

发布与市场提交遵循[分发与发布](docs/release.md)。仓库为 [takboo/dsh-session-bin](https://github.com/takboo/dsh-session-bin)；npm 包名为 `@takboo/dsh-session-bin`；版本、构建身份和 Release tarball 一起验收。
