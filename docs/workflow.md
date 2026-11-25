# 开发与验证流程

本文档定义 `@takboo/dsh-session-bin` 的统一工程入口、任务依赖、证据分级与变更验证要求。所有工具版本与任务定义以根目录 [mise.toml](../mise.toml) 为唯一事实来源，共享工程基座版本由 [dsh-engineering.lock.json](../dsh-engineering.lock.json) 锁定。

## 共享治理继承与插件自治

本仓通过 [dsh-engineering.lock.json](../dsh-engineering.lock.json) 锁定共享基座 `v0.2.0`，继承其 `docs/engineering-contract.md` 共享治理原则（不全文复写）：

- **`Verification is all you need`**：统一通过 `mise` 固定运行时与入口验证，严守 E0–E4 诚实分级（未跑标 `not-run`），并以同一候选 `.tgz` 串联 E1 与 E2/E3。
- **EGM 磁盘真相与产品 `README.md` 保护**：遵循文档分层与退场规则，工程治理改动不改写对外产品 [README.md](../README.md) 定位。
- **YAGNI 与受控交付**：优先删减冗余，变更须经独立只读复核后再提交；未经明确授权不自动 `git push` 或打版本 tag。
- **插件自治边界**：业务内核、依赖与包管理器、构建/测试框架、支持矩阵及发版节奏由本仓自治，基座门禁不侵入 `src/`。

## 环境准备与共享基座预检

1. 安装固定工具链与依赖（禁用生命周期脚本）：

   ```sh
   mise trust
   mise install
   mise run setup
   ```

   `mise run setup` 依赖 `install`（`pnpm install --frozen-lockfile --ignore-scripts`），与 CI 及容器脚本共享同一锁定安装命令。

2. **必需前置条件：配置共享工程基座 checkout 的绝对路径**。`locked-run.mjs` 仅接受 `--checkout <abs-path>`、环境变量 `DSH_ENGINEERING_CHECKOUT`（绝对路径，不能含 `..`）或 `${XDG_CONFIG_HOME:-$HOME/.config}/dsh-plugin-engineering/checkout`（单行绝对路径，不能含 `..`）之一解析基座目录。`mise.toml` 中的 `../dsh-plugin-engineering` 仅在 `DSH_ENGINEERING_CHECKOUT` 未设置且上述配置文件已就绪时用于定位 runner 脚本，不能替代 checkout 绝对路径配置。配置完成后运行预检：

   ```sh
   export DSH_ENGINEERING_CHECKOUT=/abs/path/to/dsh-plugin-engineering
   node "${DSH_ENGINEERING_CHECKOUT}/scripts/locked-run.mjs" doctor
   ```

   若已将绝对路径写入 `${XDG_CONFIG_HOME:-$HOME/.config}/dsh-plugin-engineering/checkout` 且基座位于相邻目录 `../dsh-plugin-engineering`，也可直接省略 `DSH_ENGINEERING_CHECKOUT`。

## 单一主检查入口（`mise run check`）

`mise run check` 通过显式任务 DAG 串接以下检查：

- `check:shell`：调用锁定基座的 `locked-run.mjs check-plugin`，校验 `dsh-engineering.lock.json`、`mise.toml` 合约、包声明与 `locale/en.json` 解析、根目录无散落 `.tgz`/`.zip`，以及 EGM 文档结构与全部 Markdown 链接/锚点。
- `verify:docs`：运行项目内 `scripts/verify-docs.mjs`，校验仓库内文档链接与标题锚点。
- `verify:market`：离线校验 `dshmarket` 清单、npm 仓库信息、bundle 声明与截图路径。
- `check:types`：运行 `tsc --noEmit` 与 `tsc --project tsconfig.client.json --noEmit`，检查 Host 与 Client 类型。

## 串行容器 E2 验证路径（`verify:pack` -> `verify:host:container` -> `verify:host`）

```sh
mise run verify:host
```

`verify:host` 严格按三步串行 DAG 执行（`verify:pack` -> `verify:host:container` -> `verify:host`）：

1. `mise run verify:pack`：
   - 核对当前 Node 版本与 `mise.toml` 一致，校验所有进入构建、打包与容器探针的输入相对已提交 `HEAD` 保持干净（存在未提交修改或未跟踪文件时 fail-closed）；`mise.toml` 会为每次 `mise run` 调用自动分配唯一、一次写入的 `DSH_ENGINEERING_ACTIVE_RUN_DIR`（`.local/engineering/run-<rand>`），`verify:pack` 通过原子 `mkdir` 创建该独占目录（若复用已存在目录则以 `EEXIST` 直接拒绝），再按捕获的完整 40 位 `sourceCommit` SHA 导出 `git archive` 到独立临时目录完成离线 frozen install 与隔离构建（不读写工作区共享 `dist/`，杜绝旧 `dist/` 文件泄漏），并将该归档内的 `targets.json` 原子复制到运行目录供容器消费。
   - 在独立归档副本中调用 `scripts/verify-package.mjs --save-tarball ... --save-report ...` 对**同一份**候选 tarball 完成完整 E1（导出、双语 `locale/*.json` 元数据、`cordis.patch.yml` 与真实 Cordis Loader），原子落盘 `candidate.tgz` 与 `probe.mjs`，并校验 E1 私有报告摘要后原子写入 `e1-manifest.json`。
2. `mise run verify:host:container`：
   - 调用锁定基座的 `locked-run.mjs container all`，在固定 Linux 容器内消费同一独占运行目录中的归档 `targets.json`、`probe.mjs` 与 `candidate.tgz`，执行 `admit` 宿主安装/Web 探针/卸载与 `refuse` 宿主拒绝校验，输出 `host-report.json`。
3. `mise run verify:host`：
   - 运行只读且幂等的 `node scripts/engineering/pack-host.mjs --verify-report`，交叉复核 `host-report.json` 的 `outcome`、`provenance.producer`（`git-archive` + 锁定 commit）以及 `provenance.inputs` 与 `e1-manifest.json`、当前 `HEAD`、归档提交中的 `targets.json` 和磁盘上的 `candidate.tgz` / `probe.mjs` / `targets.json` 完全一致；任一不匹配即失败。

由于每次 `mise run` 默认分配全新独占的 `DSH_ENGINEERING_ACTIVE_RUN_DIR`（`.local/engineering/run-<rand>`），并行运行、单独运行 `mise run verify:pack` 以及容器失败后直接重试均互不干扰；如需自定义目录路径，可显式传入尚未存在的 `DSH_ENGINEERING_RUN_DIR` 作为覆盖（复用已有目录会以 `EEXIST` 拒绝）。

## 其余项目验证与发布任务

| 任务 | 用途 |
| --- | --- |
| `mise run env` | 查看固定的 `node`、`pnpm`、`gh` 版本 |
| `mise run build` | 生成预编译 Host/Client 产物与类型声明 |
| `mise run test` | 在临时 `DSH_HOME` 与独立 fixture 中运行行为测试 |
| `mise run verify:package` | 打包并用真实 Cordis Loader 与 `readPluginMeta` 校验 tarball |
| `mise run verify` | 串行执行 `verify:docs`、`verify:market`、`check`、`build`、`test`、`verify:package` |
| `mise run verify:gui` / `verify:gui:locale` / `verify:gui:browser` | 准备锁定浏览器并运行中英文隔离 Web profile 的 CLI/GUI 验收 |
| `mise run verify:desktop` / `verify:desktop:gui` | 在已安装 macOS ARM64 Desktop Electron/ASAR 载体上执行隔离回归 |
| `mise run verify:platform` / `verify:linux` | 在当前 OS 或固定 Node Linux 容器内记录候选组合证据 |
| `mise run compat:discover` / `compat:check` / `compat:report` / `compat:desktop` | 发现并隔离检查上游新 DSH 版本（见 [兼容性自动检查](compatibility.md)） |
| `mise run release:check` / `release:prepare` / `release:verify` | 发布 tag 祖先校验、复用已测 tarball 与产物校验（见 [分发与发布流程](release.md)） |

## 证据分级（E0–E4）

| 级别 | 范围与定义 | 典型入口 |
| --- | --- | --- |
| **E0** | 静态与单测：壳层合约、文档链接、市场静态检查、TypeScript 类型与隔离单测 | `mise run check`、`mise run test` |
| **E1** | 同包产物验收：实际 `npm pack` tarball、exports、`locale/*.json` 元数据、`cordis.patch.yml` 与 Cordis Loader 激活/卸载 | `mise run verify`、`mise run verify:pack` |
| **E2** | 锁定宿主容器验收：在基座固定 Linux 容器内对同一 tarball 执行真实 `dsh plugin add`（admit/refuse）与 Chromium Web 探针 | `mise run verify:host` |
| **E3** | 原生平台与桌面验收：双语 GUI、五平台 CI 矩阵、原生 Desktop Electron/ASAR 或共享 Tart 实验室 | `mise run verify:gui`、`mise run verify:desktop`、CI workflow |
| **E4** | 正式发布与目录分发：打 tag 触发五平台门禁、GitHub Release 附件校验、npm trusted publishing 与 `dshmarket` 审核 | `mise run release:*`、Release workflow |

**诚实报告约束**：未执行的级别必须显式标记为 `not-run`，不得用低级别或历史记录替代当次运行；candidate 验收通过不自动扩大生产永久删除支持矩阵。

## 变更面与验证矩阵

| 变更面 | 最低必跑验证 | 说明 |
| --- | --- | --- |
| 文档、链接、工程壳层（`docs/`、`AGENTS.md`、`mise.toml`、`dsh-engineering.lock.json`） | `mise run check`；涉及打包或基座入口时加跑 `mise run verify` 与 `mise run verify:host` | 保证 `check:shell`、文档锚点与容器 provenance 全绿 |
| 打包与工程脚本（`scripts/`、`package.json`） | `mise run check`、`mise run verify`、`mise run verify:host` | 确保同一份 `.tgz` 贯通 E1 与 E2 |
| Host 生命周期、归档与永久删除（`src/host/`、`src/operations/`、`src/index.ts`） | `mise run check`、`mise run verify`、`mise run verify:host`；涉及原生删除/桌面组合时加跑 `verify:platform` / `verify:desktop` | 所有测试使用临时 `DSH_HOME` 与独立 fixture |
| 客户端界面、文案与 Remote（`src/client/`、`src/remote/`、`locale/`） | `mise run check`、`mise run verify`、`mise run verify:host`、`mise run verify:gui` | 覆盖中英文、浅色/深色主题与断线恢复 |
| 兼容性巡检与发布流水线（`scripts/compatibility/`、`scripts/release.mjs`、`.github/workflows/`） | `mise run check`、`mise run test`、`mise run verify:market` | 涉及工作流逻辑时须保留 CI 门禁与只读权限边界 |
